/**
 * GLaDOS 云端兜底巡检（GitHub Actions）
 *
 * 定位：签到已迁到用户 Mac 本地（真实 Chrome + 直连 + Turnstile）。
 * 云端机房 IP 无法生成 Turnstile token，直接签到必然 code:5，
 * 所以这里不再做签到，只做「今天到底签没签」的核对：
 *
 *   - 今天已有签到记录 → 静默绿灯，不推送（避免每天一条噪音）
 *   - 今天没有签到记录 → 推送提醒，用户还来得及手动补一次
 *   - Cookie 失效       → 推送提醒更新 Secret GLADOS
 *   - 巡检接口不可用     → Actions 变红但不推送（不制造假报警）
 *
 * 判断依据：GET /api/user/points 的 history[]，
 * detail 是 Asia/Shanghai 日期字符串（如 "2026-11-14"），
 * business 是 "system:checkin"。不用页面文字，也不用猜测。
 */

const GLADOS_DOMAINS = ['https://glados.rocks', 'https://glados.network']
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const TIMEOUT_MS = 15000
const CHECKIN_URL = 'https://glados.rocks/console/checkin'
const REPO_URL = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY || 'wuleiyuan/checkin'}`

const todayShanghai = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const ctl = new AbortController()
  const tid = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctl.signal })
  } finally {
    clearTimeout(tid)
  }
}

const request = async (path, headers) => {
  let lastErr
  for (const domain of GLADOS_DOMAINS) {
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetchWithTimeout(`${domain}${path}`, { method: 'GET', headers }, TIMEOUT_MS)
        if (res.status >= 500 && i < 2) {
          lastErr = new Error(`HTTP ${res.status} @ ${domain}`)
          await new Promise((r) => setTimeout(r, 1000 * 2 ** i))
          continue
        }
        const text = await res.text()
        try {
          return JSON.parse(text)
        } catch {
          throw new Error(`非 JSON 返回 (HTTP ${res.status}): ${text.slice(0, 120)}`)
        }
      } catch (e) {
        lastErr = e
        if (i < 2) await new Promise((r) => setTimeout(r, 1000 * 2 ** i))
      }
    }
  }
  throw lastErr
}

const push = async (title, lines) => {
  const token = process.env.NOTIFY
  if (!token) return false
  await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, title, content: lines.join('<br>'), template: 'markdown' }),
  })
  return true
}

const main = async () => {
  const cookie = process.env.GLADOS
  const today = todayShanghai()

  if (!cookie || !/gld:sess=/.test(cookie)) {
    const lines = [
      'Secret GLADOS 缺失或不完整（需 koa:sess、koa:sess.sig、gld:sess、gld:sess.sig 四枚）。',
      '本地签到脚本用的是另一个 cookie.txt，这里也要同步更新。',
      `<${REPO_URL}>`,
    ]
    console.log('巡检失败 ❌ Secret GLADOS 不完整')
    lines.forEach((l) => console.log(l))
    await push('GLaDOS 巡检配置异常', lines)
    process.exitCode = 1
    return
  }

  const headers = {
    cookie,
    origin: 'https://glados.rocks',
    referer: CHECKIN_URL,
    'user-agent': UA,
  }

  let points
  try {
    points = await request('/api/user/points', headers)
  } catch (e) {
    const lines = [`巡检接口不可用：${e.message || e}`, '云端无法核对签到状态，本地脚本仍在运行，此处不算签到失败。', `<${REPO_URL}>`]
    console.log('巡检异常 ⚠️ 接口不可用（不推送，避免假报警）')
    lines.forEach((l) => console.log(l))
    process.exitCode = 1
    return
  }

  if (points?.code === -2 || /没有权限/.test(points?.message || '')) {
    const lines = [
      'Cookie 已失效，云端与本地 cookie.txt 都需要更新。',
      '重新登录 glados.rocks，复制四枚 Cookie（koa:sess、koa:sess.sig、gld:sess、gld:sess.sig）。',
      `<${REPO_URL}>`,
    ]
    console.log('巡检失败 ❌ Cookie 已失效')
    lines.forEach((l) => console.log(l))
    await push('GLaDOS Cookie 已失效', lines)
    process.exitCode = 1
    return
  }

  const history = Array.isArray(points?.history) ? points.history : []
  const hit = history.find((x) => x.detail === today && /checkin/i.test(x.business || ''))

  if (hit) {
    // 静默绿灯：本地自动签到已干活，不推送任何消息
    console.log(`今日已签到 ✅ ${today} +${hit.change} 分，余额 ${hit.balance}（本地脚本正常，静默）`)
    console.log(`积分：${points.points} | 连续：${points.streak ?? '?'} 天`)
    return
  }

  // 真漏签：这是唯一值得推送的情况
  const lines = [
    `巡检日期：${today}（Asia/Shanghai）`,
    `结果：今天没有找到签到记录，本地自动签到可能没跑（Mac 关机 / 休眠 / 脚本异常 / Cookie 失效）。`,
    `当前积分：${points?.points ?? '未知'}`,
    `请手动打开 ${CHECKIN_URL} 点一次 Checkin，当天补上即可，连续天数不会清零太多。`,
    `<${REPO_URL}>`,
  ]
  console.log('巡检结果 ⚠️ 今日未签到')
  lines.forEach((l) => console.log(l))
  const sent = await push('⚠️ GLaDOS 今日未签到，请手动补一次', lines)
  console.log(sent ? '已推送提醒' : '未配置 NOTIFY，未推送')
  process.exitCode = 1
}

main()
