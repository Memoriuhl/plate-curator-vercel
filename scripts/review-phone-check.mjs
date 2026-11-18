import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { REVIEW_BASE_URL, REVIEW_STORAGE_STATE, REVIEW_PATH } = process.env
assert(
  REVIEW_BASE_URL && REVIEW_STORAGE_STATE && REVIEW_PATH,
  'Set REVIEW_BASE_URL, REVIEW_STORAGE_STATE and REVIEW_PATH for a staging comparison'
)
const env = await readFile('.env.local', 'utf8')
assert.match(env, /^GCP_PROJECT_ID="?license-plate-game-staging"?\s*$/m)
assert.match(
  env,
  /^NEXT_PUBLIC_FIREBASE_PROJECT_ID="?license-plate-game-staging"?\s*$/m
)
const target = new URL(REVIEW_PATH, REVIEW_BASE_URL)
assert.equal(target.origin, new URL(REVIEW_BASE_URL).origin)
assert.equal(target.pathname, '/review')
const batchId = target.searchParams.get('batch')
assert(batchId && target.searchParams.get('plate'), 'Select a batch and plate')
const output = resolve(process.env.REVIEW_SCREENSHOTS || '.next/review-phone')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({
    storageState: REVIEW_STORAGE_STATE,
  })
  const page = await context.newPage()
  const errors = []
  let selectedBatch
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', async (response) => {
    if (
      new URL(response.url()).pathname === `/api/batches/${batchId}` &&
      response.ok()
    ) {
      selectedBatch = (await response.json()).batch
    }
  })
  await page.route('**/api/**', (route) =>
    route.request().method() === 'GET' ? route.continue() : route.abort()
  )
  for (const stress of [false, true]) {
    if (stress)
      await page.route('**/api/batches?*', (route) =>
        route.fulfill({ json: [selectedBatch] })
      )
    if (stress)
      await page.route(`**/api/batches/${batchId}`, async (route) => {
        const response = await route.fetch()
        assert(response.ok(), 'Staging batch must load')
        const detail = await response.json()
        detail.batch.revision = 24
        detail.batch.name = 'Review'.repeat(20)
        detail.batch.createdByName = 'Curator'.repeat(12)
        for (const entry of detail.plates) {
          entry.proposed.displayName = 'LongPlateName'.repeat(8)
          entry.proposed.tags.push('UnbrokenTag'.repeat(10))
          entry.proposed.description = 'Description'.repeat(30)
          entry.proposed.sourceUrl = 'Reference'.repeat(30)
        }
        await route.fulfill({ response, json: detail })
      })
    await page.setViewportSize({ width: 400, height: 900 })
    await page.goto(target.href)
    const before = page.getByRole('region', { name: 'Before', exact: true })
    const after = page.getByRole('region', { name: 'After', exact: true })
    await before.waitFor({ timeout: 60000 })
    const scripts = await page
      .locator('script[src]')
      .evaluateAll(async (nodes) =>
        (
          await Promise.all(
            nodes.map((node) =>
              fetch(node.src).then((response) => response.text())
            )
          )
        ).join('\n')
      )
    assert(
      scripts.includes('license-plate-game-staging'),
      'Running app must use staging Firebase'
    )
    /**
     * Measure the review view and capture its mobile screenshot after checking layout
     * bounds.
     */
    const measure = async (label) => {
      const sizes = await page.evaluate(() => ({
        viewport: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }))
      assert(
        sizes.scrollWidth <= sizes.viewport,
        `${label}: ${JSON.stringify(sizes)}`
      )
      for (const pane of [before, after]) {
        if (!(await pane.isVisible())) continue
        assert(
          await pane.evaluate((node) => node.scrollWidth <= node.clientWidth),
          `${label}: pane overflows`
        )
      }
      console.log(
        JSON.stringify({
          scenario: stress ? 'long-content' : 'staging',
          label,
          ...sizes,
        })
      )
      await page.screenshot({
        path: resolve(
          output,
          `${stress ? 'long-content' : 'staging'}-${label}.png`
        ),
        fullPage: true,
      })
    }
    const toggle = page.getByRole('group', { name: 'Comparison view' })
    assert.equal(await after.isVisible(), false)
    assert.equal(
      await toggle
        .getByRole('button', { name: 'Before', exact: true })
        .getAttribute('aria-pressed'),
      'true'
    )
    await measure('400-before')
    await toggle.getByRole('button', { name: 'After', exact: true }).focus()
    await page.keyboard.press('Enter')
    assert.equal(await after.isVisible(), true)
    assert.equal(await before.isVisible(), false)
    assert.equal(
      await toggle
        .getByRole('button', { name: 'After', exact: true })
        .getAttribute('aria-pressed'),
      'true'
    )
    await measure('400-after')
    await toggle.getByRole('button', { name: 'Before', exact: true }).click()
    assert.equal(await before.isVisible(), true)
    assert.equal(await after.isVisible(), false)
    for (const width of [768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.equal(await toggle.isVisible(), false)
      assert.equal(await before.isVisible(), true)
      assert.equal(await after.isVisible(), true)
      const left = await before.boundingBox()
      const right = await after.boundingBox()
      assert(
        Math.abs(left.y - right.y) < 1 && right.x > left.x,
        'Desktop panes must remain side by side'
      )
      await measure(`${width}-both`)
    }
    await page.setViewportSize({ width: 400, height: 900 })
    assert.equal(await after.isVisible(), false)
    if (!stress) continue
    await page.getByRole('link', { name: 'Plates', exact: true }).click()
    await page.getByRole('region', { name: 'Plates', exact: true }).waitFor()
    await measure('400-plates')
    await page.getByRole('link', { name: 'States', exact: true }).click()
    await page
      .getByRole('heading', { name: 'States with changes first' })
      .waitFor()
    await measure('400-states')
  }
  assert.deepEqual(errors, [], 'Browser errors')
  console.log(`Screenshots: ${output}`)
} finally {
  await browser.close()
}
