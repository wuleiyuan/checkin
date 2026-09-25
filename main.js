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
 *   -2  - 没有权限（Cookie 失效）
 *   其它 - 未定义，统一视为失败但保留详情
 *
 * 鲁棒性：
 *   - 每个 fetch 带 3 次指数退避重试（应对 Actions runner 偶发瞬时网络抖动）
 *   - fetch 自带 timeout，避免被卡死
 *   - status 查询失败不影响主判定
 */

const GLADOS_URL = 'https://glados.rocks'
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

// 带 3 次指数退避的请求
const request = async (path, options) => {
  const url = `${GLADOS_URL}${path}`
  let lastErr
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetchWithTimeout(url, options, TIMEOUT_MS)
      if (res.status >= 500 && i < 2) {
        lastErr = new Error(`HTTP ${res.status}`)
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)))
        continue
      }
      return await parseJson(res)
    } catch (e) {
      lastErr = e
      if (i < 2) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)))
        continue
      }
    }
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
    origin: GLADOS_URL,
    referer: `${GLADOS_URL}/console/checkin`,
    'user-agent': UA,
  }

  try {
    const checkin = await request('/api/user/checkin', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'glados.one' }),
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
      hint = '请重新登录 glados.rocks 抓取新的 Cookie，更新 Secret GLADOS'
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
