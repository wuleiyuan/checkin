// 实验脚本：在 GitHub 托管 runner 里用「有界面真浏览器」尝试求解 Cloudflare Turnstile。
// 只做探测，不改动账号状态；输出 token 长度与签到接口返回，用于判断云端能否自主签到。
import { chromium } from 'playwright-core'

const cookieStr = process.env.GLADOS || ''
const cookies = cookieStr
  .split(';')
  .filter((p) => p.trim())
  .map((part) => {
    const [name, ...rest] = part.trim().split('=')
    return {
      name: name.trim(),
      value: rest.join('=').trim(),
      domain: 'glados.rocks',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    }
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  console.log('[env] cookie count =', cookies.length)
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  })
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })
  await ctx.addCookies(cookies)
  const page = await ctx.newPage()

  page.on('requestfailed', (r) => {
    if (/cloudflare|turnstile|challenge/i.test(r.url())) {
      console.log('[reqfail]', r.url().slice(0, 130), r.failure()?.errorText)
    }
  })
  let apiResp = null
  page.on('response', async (r) => {
    if (r.url().includes('/api/user/checkin') && !r.url().includes('challenge')) {
      try { apiResp = (await r.text()).slice(0, 400) } catch {}
    }
  })

  await page.goto('https://glados.rocks/console/checkin', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })

  let tokenLen = 0
  for (let i = 0; i < 12; i++) {
    await sleep(5000)
    tokenLen = await page.evaluate(
      () => document.querySelector('input[name="cf-turnstile-response"]')?.value?.length || 0
    )
    console.log('[wait]', (i + 1) * 5, 's tokenLen =', tokenLen)
    if (tokenLen > 20) break
  }

  const info = await page.evaluate(() => ({
    ua: navigator.userAgent,
    webdriver: navigator.webdriver,
    tokenLen: document.querySelector('input[name="cf-turnstile-response"]')?.value?.length || 0,
    failText: /verification failed|验证失败|challenge/i.test(document.body.innerText),
  }))
  console.log('[INFO]', JSON.stringify(info))

  const btn = page.getByRole('button', { name: /^Checkin$/i }).first()
  if (await btn.count()) {
    await btn.click().catch((e) => console.log('[click err]', e.message))
    for (let i = 0; i < 8 && !apiResp; i++) await sleep(4000)
  } else {
    console.log('[btn] Checkin 按钮不存在（今日已签到时会被隐藏）')
  }
  console.log('[CHECKIN_RESP]', apiResp || '未捕获')
  console.log('[RESULT]', tokenLen > 20 ? 'TURNSTILE_TOKEN_OK' : 'TURNSTILE_TOKEN_MISSING')

  await browser.close()
})().catch((e) => {
  console.error('[FATAL]', e.message)
  process.exit(1)
})
