/**
 * GLaDOS 云端兜底巡检（GitHub Actions）
 *
 * 定位：签到已迁到用户 Mac 本地（真实 Chrome + 直连 + Turnstile）。
 * 云端机房 IP 无法生成 Turnstile token，直接签到必然 code:5，
 * 所以这里只做「该核对的那天到底签没签」的核对：
 *
 *   - 该日已有签到记录 → 静默绿灯，不推送（避免每天一条噪音）
 *   - 该日没有签到记录 → 推送提醒
 *   - Cookie 失效       → 推送提醒更新 Secret GLADOS
 *   - 巡检接口不可用     → Actions 变红但不推送（不制造假报警）
 *
 * 为什么不能无脑查「今天」：
 * GitHub 免费版 scheduled workflow 常延迟数小时。实测 2026-11-15 晚班
 * 从 UTC 14:23 被延迟到 19:50（北京次日 03:50），巡检按运行当天查，
 * 凌晨当然查不到签到 → 误报漏签、推送假报警、Actions 变红。
 * 规则：北京时间 00:00-08:59 运行，核对「昨天」（当天签到窗口 08:17/08:45
 * 还没到，不算漏签）；09:00 及以后核对「今天」。
 *
 * 判断依据：GET /api/user/points 的 history[]，
 * detail 是 Asia/Shanghai 日期字符串（如 "2026-11-14"），
 * business 是 "system:checkin"。不用页面文字，也不用猜测。
 *
 * MONITOR_NOW 仅用于本地测试注入时间，线上不设置。
 */

const GLADOS_DOMAINS = ['https://glados.rocks', 'https://glados.network']
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const TIMEOUT_MS = 15000
const CHECKIN_URL = 'https://glados.rocks/console/checkin'
const REPO_URL = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY || 'wuleiyuan/checkin'}`

const shanghaiDate = (d) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)

/** 本次巡检应该核对哪一天。凌晨运行 → 核对昨天；白天/晚上 → 核对今天。 */
const resolveTarget = (now) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (t) => parts.find((p) => p.type === t)?.value
  const hour = Number(get('hour'))
  const hh = String(hour).padStart(2, '0')
  const today = shanghaiDate(now)

  if (hour < 9) {
    return {
      date: shanghaiDate(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
      today,
      hour,
      reason: `北京时间 ${hh} 点，当天签到窗口（08:17/08:45）还没到，核对昨日`,
    }
  }
  return { date: today, today, hour, reason: `北京时间 ${hh} 点，核对当日` }
}

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
  const now = process.env.MONITOR_NOW ? new Date(process.env.MONITOR_NOW) : new Date()
  const { date: targetDate, today, reason } = resolveTarget(now)
  console.log(`巡检目标日期：${targetDate}｜${reason}（运行日 ${today}）`)

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
  const hit = history.find((x) => x.detail === targetDate && /checkin/i.test(x.business || ''))

  if (hit) {
    // 静默绿灯：本地自动签到已干活，不推送任何消息
    console.log(`${targetDate} 已签到 ✅ +${hit.change} 分，余额 ${hit.balance}（静默）`)
    console.log(`积分：${points.points} | 连续：${points.streak ?? '?'} 天`)
    return
  }

  const isPastDay = targetDate !== today
  const lines = [
    `巡检日期：${targetDate}（Asia/Shanghai）`,
    `运行时刻：${today}，${reason}`,
    `结果：${targetDate} 没有找到签到记录。`,
    isPastDay
      ? '该日期已过，无法补签。请检查本地脚本当天为何没跑（Mac 关机 / 休眠 / 断网 / Cookie 失效）。'
      : `请手动打开 ${CHECKIN_URL} 点一次 Checkin，当天补上即可。`,
    `当前积分：${points?.points ?? '未知'}`,
    `<${REPO_URL}>`,
  ]
  console.log(`巡检结果 ⚠️ ${targetDate} 未签到`)
  lines.forEach((l) => console.log(l))
  const sent = await push(`⚠️ GLaDOS ${targetDate} 未签到`, lines)
  console.log(sent ? '已推送提醒' : '未配置 NOTIFY，未推送')
  process.exitCode = 1
}

main()
