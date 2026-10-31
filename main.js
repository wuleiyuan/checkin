/**
 * GLaDOS 自动签到
 *
 * 判定原则：GLaDOS 接口在 Cookie 失效/未授权时**依然返回 HTTP 200**，
 * 响应体为 {"code":-2,"message":"没有权限"}。因此绝不能靠 HTTP 状态码
 * 或「有没有抛异常」判断成败，只能看响应体里的 code。
 *
 * 已观察到的 code：
 *   0   - 签到成功
 *   1   - 今日已签到（重复执行，GLaDOS 拒绝加分）
 *   -2  - 没有权限（Cookie 不完整或失效）
 *   其它 - 未定义，统一视为失败但保留详情
 *
 * Cookie 要求（2026-10-30 实测）：
 *   必须包含全部四枚：koa:sess、koa:sess.sig、gld:sess、gld:sess.sig。
 *   GLaDOS 新增了 gld:sess 校验，只带 koa 两枚会返回 code:-2「没有权限」，
 *   极易被误判为「Cookie 已失效」。
 *
 * 鲁棒性：
 *   - 双域名轮询（glados.rocks 主，glados.network 备），单域名 5xx 自动切换
 *   - 每个 fetch 带 3 次指数退避重试（应对 Actions runner 偶发瞬时网络抖动）
 *   - fetch 自带 timeout，避免被卡死
 *   - status 查询失败不影响主判定
 */

const GLADOS_DOMAINS = ['https://glados.rocks', 'https://glados.network']
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const TIMEOUT_MS = 15000

// 带超时的 fetch
const fetchWithTimeout = async (url, options, timeoutMs) => {
  const ctl = new AbortController()
  const tid = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctl.signal })
  } finally {
    clearTimeout(tid)
  }
}

// 单次请求解析 JSON
const parseJson = async (res) => {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`接口返回非 JSON (HTTP ${res.status}): ${text.slice(0, 120)}`)
  }
}

// 带 3 次指数退避 + 双域名轮询的请求
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
        if (i < 2) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)))
        }
      }
    }
    // 当前域名 3 次都失败，换下一个域名
  }
  throw lastErr
}

const glados = async () => {
  const cookie = process.env.GLADOS
  if (!cookie) {
    return {
      ok: false,
      title: '签到失败 ❌ 未配置 Cookie',
      lines: ['Secret GLADOS 为空，请在仓库 Settings → Secrets 中添加'],
    }
  }

  const headers = {
    cookie,
    origin: 'https://glados.rocks',
    referer: 'https://glados.rocks/console/checkin',
    'user-agent': UA,
  }

  // 前置校验：缺 gld:sess 必然 code:-2，直接给出明确修复提示
  if (!/gld:sess=/.test(cookie)) {
    return {
      ok: false,
      title: '签到失败 ❌ Cookie 不完整',
      lines: [
        'Secret GLADOS 里没有 gld:sess。',
        'GLaDOS 现在要求四枚 Cookie 全带：koa:sess、koa:sess.sig、gld:sess、gld:sess.sig，缺 gld:sess 会报 code:-2「没有权限」。',
        '请重新登录 glados.rocks，从浏览器 DevTools → Application → Cookies 复制全部四枚，更新 Secret GLADOS。',
        `<${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}>`,
      ],
    }
  }

  try {
    const checkin = await request('/api/user/checkin', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ refCode: 'user-center' }),
    })

    let leftText = '获取失败（一般来说意味着 Cookie 已失效）'
    try {
      const status = await request('/api/user/status', { method: 'GET', headers })
      const leftDays = status?.data?.leftDays
      if (leftDays !== undefined && leftDays !== null && !Number.isNaN(Number(leftDays))) {
        leftText = `${Number(leftDays).toFixed(2)} 天`
      }
    } catch (e) {
      // status 失败不阻塞主判定
    }

    const code = checkin?.code
    const message = checkin?.message ?? '接口未返回 message'
    let ok = false
    let title = ''
    let hint = ''

    if (code === 0) {
      ok = true
      title = '签到成功 ✅'
    } else if (code === 1 || /repeat|already|已签/i.test(message)) {
      ok = true
      title = '今日已签到（重复执行）'
    } else if (code === -2 || /没有权限|未登录|失效|过期|token|login/i.test(message)) {
      title = '签到失败 ❌ Cookie 已失效'
      hint =
        '若 Secret 已含四枚 Cookie 仍报此错，说明服务端会话已轮换：请重新登录 glados.rocks 抓取四枚 Cookie（koa:sess、koa:sess.sig、gld:sess、gld:sess.sig），更新 Secret GLADOS'
    } else {
      const looksAuthOk = /\d+\.\d+\s*天/.test(leftText)
      if (looksAuthOk) {
        ok = true
        title = `今日已签到（接口 code=${code}，但账号认证正常）`
      } else {
        title = `签到失败 ❌ (code=${code})`
        hint = '请查看下方原始返回，或手动登录控制台确认账号状态'
      }
    }

    const lines = [
      `结果：${title}`,
      `接口 code：${code}`,
      `接口信息：${message}`,
      `剩余天数：${leftText}`,
      hint ? `处理建议：${hint}` : '',
      `原始返回：${JSON.stringify(checkin)}`,
      `<${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}>`,
    ].filter(Boolean)

    return { ok, title, lines }
  } catch (error) {
    return {
      ok: false,
      title: '签到异常 ❌',
      lines: [
        `错误：${error.message || error}`,
        '可能原因：网络被拦截、Cloudflare 挑战、Cookie 含多余空格或换行',
        `<${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}>`,
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
    body: JSON.stringify({
      token,
      title,
      content: lines.join('<br>'),
      template: 'markdown',
    }),
  })
}

const main = async () => {
  const result = await glados()
  console.log(result.title)
  result.lines.forEach((line) => console.log(line))
  await notify(result.title, result.lines)
  // 失败时让 Actions 变红，避免「绿灯假象」
  if (!result.ok) process.exitCode = 1
}

main()
