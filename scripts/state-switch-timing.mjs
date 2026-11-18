import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.TIMING_BASE_URL
if (!base || !process.env.TIMING_CREDENTIALS) throw new Error('Set TIMING_BASE_URL and TIMING_CREDENTIALS')
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.route('**/api/**', route => route.request().method() === 'GET' ? route.continue() : route.abort())
  let authError = false
  page.on('response', async response => {
    if (response.url().includes('identitytoolkit') && !response.ok()) {
      authError = true
      const body = await response.text()
      console.error(body.includes('TOO_MANY_ATTEMPTS_TRY_LATER') ? 'TOO_MANY_ATTEMPTS_TRY_LATER' : 'INVALID_LOGIN_CREDENTIALS')
    }
  })
  await page.goto(new URL('/sign-in', base).href)
  const source = await readFile(process.env.TIMING_CREDENTIALS, 'utf8')
  const line = source.split('\n').find(line => /^- editor:/.test(line))
  if (!line) throw new Error('Editor account missing')
  const [account, password] = line.trimEnd().split(' / ')
  await page.locator('#email').fill(account.slice(account.indexOf(':') + 1).trim())
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Sign in with email' }).click()
  await page.waitForURL(url => url.pathname !== '/sign-in', { timeout: 30000 }).catch(() => { throw new Error(authError ? 'Authentication rejected; stop signing in' : 'Sign-in did not finish') })
  await page.goto(new URL('/states/AL', base).href)
  await page.locator('article[data-drag-family^="AL."]').first().waitFor({ timeout: 60000 })
  let requests = []
  page.on('requestfinished', async request => {
    const url = new URL(request.url())
    if (!url.searchParams.has('_rsc') && !url.pathname.startsWith('/api/')) return
    const timing = request.timing()
    const sizes = await request.sizes().catch(() => ({}))
    requests.push({ path: url.pathname, rsc: url.searchParams.has('_rsc'), prefetch: request.headers()['next-router-prefetch'] ?? null, ttfb: Math.round(timing.responseStart), bytes: sizes.responseBodySize })
  })
  for (const code of ['MD', 'AK', 'MD', 'TX', 'CA', 'AL']) {
    const card = page.locator(`a.jurisdiction-card[href="/states/${code}"]`)
    await card.scrollIntoViewIfNeeded()
    requests = []
    if (code === 'TX') { await card.hover(); await page.waitForTimeout(1500) }
    const beforeClick = [...requests]
    requests = []
    await page.evaluate(code => {
      const start = performance.now()
      window.switchTiming = { url: null, cards: null, spinner: false }
      /**
       * Poll animation frames until the selected state renders and its navigation timing
       * is available.
       */
      const poll = () => {
        const timing = window.switchTiming
        if (location.pathname === `/states/${code}` && timing.url === null) timing.url = performance.now() - start
        if (document.querySelector('[data-navigation-pending]')) timing.spinner = true
        if (document.querySelector(`article[data-drag-family^="${code}."]`)) timing.cards = performance.now() - start
        else requestAnimationFrame(poll)
      }
      requestAnimationFrame(poll)
      document.querySelector(`a.jurisdiction-card[href="/states/${code}"]`).click()
    }, code)
    await page.waitForFunction(() => window.switchTiming.cards !== null, null, { timeout: 60000 })
    const timing = await page.evaluate(() => window.switchTiming)
    await page.waitForTimeout(1000)
    console.log(JSON.stringify({ code, urlMs: Math.round(timing.url), cardsMs: Math.round(timing.cards), spinner: timing.spinner, selected: await card.getAttribute('aria-current'), beforeClick, requests }))
  }
  for (const width of [1440, 400]) {
    await page.setViewportSize({ width, height: 1000 })
    const filters = page.getByRole('group', { name: 'Filter plates', exact: true })
    await filters.getByRole('button', { name: /Under-tagged/ }).click()
    await page.waitForURL(url => url.searchParams.get('show') === 'undertagged')
    await filters.getByRole('button', { name: /All plates/ }).click()
    await page.waitForURL(url => url.searchParams.get('show') === 'all')
    await page.getByRole('combobox', { name: 'Region', exact: true }).click()
    const regions = await page.getByRole('option').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, disabled: node.getAttribute('aria-disabled') })))
    await page.getByRole('option', { name: /United States/ }).click()
    await page.waitForURL(url => url.pathname.startsWith('/states/'))
    await page.locator('article[data-drag-family]').first().waitFor()
    console.log(JSON.stringify({ width, selected: await page.locator('a.jurisdiction-card[aria-current="page"]').count(), overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), filters: 'passed', regions }))
  }
} finally {
  await browser.close()
}
