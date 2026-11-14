/**
 * GLaDOS 自动签到
 *
 * 判定原则（2026-11-14 修订）：
 *   只有 code === 0（签到成功）或 code === 1（今日已签到）算成功。
 *   其它任何 code 一律失败、Actions 变红。绝不因为「账号认证正常」就判成功——
 *   那会造成「提示成功但实际没签到」的假绿灯。
 *
 * 已观察到的 code：
 *   0   - 签到成功
 *   1   - 今日已签到
 *   -2  - 没有权限（Cookie 不完整或失效）
 *   5   - Cloudflare Turnstile 人机验证未通过（reason: turnstile，retryable: true）
 *   其它 - 未知，一律失败并保留详情
 *
 * 云端静默模式（环境变量 EXPECT_TURNSTILE_BLOCK=1）：
 *   GitHub 机房 IP 必然被 CF 拦截，这是已知策略限制，不是故障。
 *   该模式下 code:5 记为「跳过」并让 Actions 保持绿灯，日志仍保留完整原始返回；
 *   真签到由本机保底完成，22:00 的 monitor.js 独立核对当天是否签到，
 *   真漏签 / Cookie 失效依旧会推提醒，因此不会掩盖问题。
 *   仅自动定时启用；手动诊断（workflow_dispatch）不设此变量，仍能看到真实失败。
 *
 * Cookie 要求（2026-10-30 实测）：
 *   必须包含全部四枚：koa:sess、koa:sess.sig、gld:sess、gld:sess.sig。
 *
 * 2026-11 起 GLaDOS 签到前置流程（逆向自官方前端 JS）：
 *   1) GET  /api/user/checkin/challenge -> { nonce, ttl, turnstile: sitekey }
 *   2) proof = SHA-256(nonce + '.glados-observe-v1') 的 hex
 *   3) 浏览器渲染 Cloudflare Turnstile 组件拿到 token
 *   4) POST /api/user/checkin  { nonce, proof, tsState, turnstile }
 *   本脚本能完成 1、2、4，但无法在 CI 里生成第 3 步的 token。
 *   若服务端返回 code:5，说明人机验证未过 —— 必须去浏览器手动点一次 Checkin。
 *   可选：通过 Secret TURNSTILE_TOKEN 注入浏览器里拿到的实时 token（有效期很短）。
 *
 * 鲁棒性：
 *   - 双域名轮询（glados.rocks 主，glados.network 备）
 *   - code:5 / retryable 时换全新 nonce 重试 3 次
 *   - 每个 fetch 带 timeout + 指数退避
 */

import crypto from 'node:crypto'

const GLADOS_DOMAINS = ['https://glados.rocks', 'https://glados.network']
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const TIMEOUT_MS = 15000
const REPO_URL = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY || 'wuleiyuan/checkin'}`

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const ctl = new AbortController()
  const tid = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctl.signal })
  } finally {
    clearTimeout(tid)
  }
}

const parseJson = async (res) => {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`接口返回非 JSON (HTTP ${res.status}): ${text.slice(0, 120)}`)
  }
}

const request = async (path, options) => {
  let lastErr
  for (const domain of GLADOS_DOMAINS) {
    const url = `${domain}${path}`
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetchWithTimeout(url, options, TIMEOUT_MS)
        if (res.status >= 500 && i < 2) {
          lastErr = new Error(`HTTP ${res.status} @ ${domain}`)
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)))
          continue
        }
        return await parseJson(res)
      } catch (e) {
        lastErr = e
        if (i < 2) await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)))
      }
    }
  }
  throw lastErr
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const glados = async () => {
  const cookie = process.env.GLADOS
  if (!cookie) {
    return { ok: false, title: '签到失败 ❌ 未配置 Cookie', lines: ['Secret GLADOS 为空，请在仓库 Settings → Secrets 中添加', `<${REPO_URL}>`] }
  }
  if (!/gld:sess=/.test(cookie)) {
    return {
      ok: false,
      title: '签到失败 ❌ Cookie 不完整',
      lines: [
        'Secret GLADOS 里没有 gld:sess。',
        'GLaDOS 要求四枚 Cookie 全带：koa:sess、koa:sess.sig、gld:sess、gld:sess.sig。',
        '请重新登录 glados.rocks，从 DevTools → Application → Cookies 复制全部四枚，更新 Secret GLADOS。',
        `<${REPO_URL}>`,
      ],
    }
  }

  const headers = {
    cookie,
    origin: 'https://glados.rocks',
    referer: 'https://glados.rocks/console/checkin',
    'user-agent': UA,
  }

  const statusOnce = async () => {
    try {
      const status = await request('/api/user/status', { method: 'GET', headers })
      const d = Number(status?.data?.leftDays)
      return Number.isFinite(d) ? `${d.toFixed(2)} 天` : '获取失败'
    } catch {
      return '获取失败'
    }
  }

  try {
    let checkin = null
    const attempts = 3
    for (let i = 0; i < attempts; i++) {
      // 每轮换全新 nonce，避免复用过期 challenge
      let nonce = ''
      try {
        const ch = await request('/api/user/checkin/challenge', { method: 'GET', headers })
        nonce = ch?.code === 0 && ch.nonce ? ch.nonce : ''
      } catch {
        nonce = ''
      }
      const proof = nonce ? crypto.createHash('sha256').update(`${nonce}.glados-observe-v1`).digest('hex') : ''
      const token = process.env.TURNSTILE_TOKEN || ''
      const body = nonce
        ? { nonce, proof, tsState: token ? 'ok' : 'unavailable', ...(token ? { turnstile: token } : {}) }
        : { refCode: 'user-center' }

      checkin = await request('/api/user/checkin', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (checkin?.code === 0 || checkin?.code === 1) break
      if (i < attempts - 1 && (checkin?.retryable || checkin?.code === 5)) {
        await sleep(3000 * (i + 1))
        continue
      }
      break
    }

    const leftText = await statusOnce()
    const code = checkin?.code
    const message = checkin?.message ?? '接口未返回 message'
    let ok = false
    let title = ''
    let hint = ''

    if (code === 0) {
      ok = true
      title = '签到成功 ✅'
    } else if (code === 1) {
      ok = true
      title = '今日已签到（重复执行）'
    } else if (code === 5 || checkin?.reason === 'turnstile') {
      if (process.env.EXPECT_TURNSTILE_BLOCK === '1') {
        // 预期内的策略拦截：不算故障，Actions 保持绿灯；巡检会独立复核是否真漏签
        ok = true
        title = '云端签到跳过 ⏭️ Cloudflare 拦截（预期内，本机保底）'
        hint =
          'GitHub 机房 IP 无法生成 Turnstile token，属已知策略限制。本机 08:45 完成签到，22:00 巡检负责核对；真漏签仍会推送提醒。手动诊断不设 EXPECT_TURNSTILE_BLOCK 即可看到真实 code:5。'
      } else {
        title = '签到失败 ❌ 需要 Cloudflare 人机验证'
        hint =
          'GLaDOS 已启用 Turnstile，CI 纯 API 无法生成验证 token。请手动打开 https://glados.rocks/console/checkin 点击 Checkin（一天一次，10 秒）'
      }
    } else if (code === -2 || /没有权限|未登录|失效|过期|token|login/i.test(message)) {
      title = '签到失败 ❌ Cookie 已失效'
      hint =
        '请重新登录 glados.rocks 抓取四枚 Cookie（koa:sess、koa:sess.sig、gld:sess、gld:sess.sig），更新 Secret GLADOS'
    } else {
      title = `签到失败 ❌ (code=${code})`
      hint = '请查看原始返回，或手动登录控制台确认账号状态'
    }

    const lines = [
      `结果：${title}`,
      `接口 code：${code}`,
      `失败原因：${checkin?.reason ?? '无'}`,
      `接口信息：${message}`,
      `剩余天数：${leftText}`,
      hint ? `处理建议：${hint}` : '',
      `原始返回：${JSON.stringify(checkin)}`,
      `<${REPO_URL}>`,
    ].filter(Boolean)

    return { ok, title, lines }
  } catch (error) {
    return {
      ok: false,
      title: '签到异常 ❌',
      lines: [
        `错误：${error.message || error}`,
        '可能原因：网络被拦截、Cloudflare 挑战、Cookie 含多余空格或换行',
        `<${REPO_URL}>`,
      ],
    }
  }
}

const notify = async (title, lines) => {
  const token = process.env.NOTIFY
  if (!token || !lines || !lines.length) return
  await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, title, content: lines.join('<br>'), template: 'markdown' }),
  })
}

const main = async () => {
  const result = await glados()
  console.log(result.title)
  result.lines.forEach((line) => console.log(line))
  await notify(result.title, result.lines)
  // 失败时让 Actions 变红，杜绝「绿灯假象」
  if (!result.ok) process.exitCode = 1
}

main()
