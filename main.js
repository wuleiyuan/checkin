/**
 * GLaDOS 自动签到
 *
 * 判定原则：GLaDOS 接口在 Cookie 失效/未授权时**依然返回 HTTP 200**，
 * 响应体为 {"code":-2,"message":"没有权限"}。因此绝不能靠 HTTP 状态码
 * 或「有没有抛异常」判断成败，只能看响应体里的 code。
 */

const GLADOS_URL = 'https://glados.rocks'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

// 统一请求：把「非 JSON 返回」（Cloudflare 拦截页 / 登录跳转页）显式暴露出来
const request = async (path, options) => {
  const res = await fetch(`${GLADOS_URL}${path}`, options)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`接口返回非 JSON (HTTP ${res.status}): ${text.slice(0, 120)}`)
  }
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

    const status = await request('/api/user/status', { method: 'GET', headers })
    const leftDays = status?.data?.leftDays
    const leftText =
      leftDays === undefined || leftDays === null || Number.isNaN(Number(leftDays))
        ? '获取失败（一般来说意味着 Cookie 已失效）'
        : `${Number(leftDays).toFixed(2)} 天`

    // 按 code 判定真实结果，而不是「没抛异常就算成功」
    const code = checkin?.code
    const message = checkin?.message ?? '接口未返回 message'
    let ok = false
    let title = ''
    let hint = ''

    if (code === 0) {
      ok = true
      title = '签到成功 ✅'
    } else if (code === 1 || /repeat/i.test(message)) {
      ok = true
      title = '今日已签到（重复执行）'
    } else if (code === -2 || /没有权限|未登录|失效|过期|token|login/i.test(message)) {
      title = '签到失败 ❌ Cookie 已失效'
      hint = '请重新登录 glados.rocks 抓取新的 Cookie，更新 Secret GLADOS'
    } else {
      title = `签到失败 ❌ (code=${code})`
      hint = '请查看下方原始返回，或手动登录控制台确认账号状态'
    }

    const lines = [
      `结果：${title}`,
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
        '常见原因：网络被拦截、Cloudflare 挑战、Cookie 含多余空格或换行',
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
