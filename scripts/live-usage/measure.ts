/**
 * Measure how many requests and Firestore operations an open Dashboard causes while a
 * 40-plate pipeline run progresses. See docs/live-updates.md for the method.
 *
 * Runs only against a local dev server that uses the Firebase emulators and a `demo-`
 * project. A scripted worker reports fake results, so no model is called.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { Firestore } from '@google-cloud/firestore'
import { firestoreJobsStore } from '../../lib/jobs/firestore-store'
import { localJobsEnvironment } from '../../lib/jobs/local-scope'
import type { UsageCounts } from '../../lib/dev/usage-counter'
import { runLoop, type WorkerDeps } from '../../worker/run'

const require = createRequire(import.meta.url)
const env = process.env
const base = env.USAGE_BASE_URL ?? 'http://localhost:3315'
const project = env.GCP_PROJECT_ID ?? ''
const authHost = env.FIREBASE_AUTH_EMULATOR_HOST ?? ''
const scope = env.LOCAL_PIPELINE_SCOPE ?? ''
const counterFile = env.USAGE_COUNTER_FILE ?? ''
const minutes = Number(env.USAGE_MINUTES ?? 10)
const runAtSeconds = Number(env.USAGE_RUN_AT_SECONDS ?? 60)
/** Observe with the drawer open and no run queued. */
const idle = env.USAGE_IDLE === '1'
const sharedDraft = env.USAGE_SHARED_DRAFT === '1'
const jobMs = Number(env.USAGE_JOB_MS ?? 4000)
const label = env.USAGE_LABEL ?? 'run'
const output = resolve(env.USAGE_OUTPUT ?? '.next/live-usage')
const owner = { uid: 'usage-owner', email: 'owner@example.com', role: 'owner' }
const editor = {
  uid: 'usage-editor',
  email: 'editor@example.com',
  role: 'editor',
}
const password = randomUUID()

if (!project.startsWith('demo-'))
  throw new Error('Set GCP_PROJECT_ID to a demo- project; staging is refused')
if (!env.FIRESTORE_EMULATOR_HOST || !authHost)
  throw new Error('Set FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST')
if (!scope || !counterFile)
  throw new Error('Set LOCAL_PIPELINE_SCOPE and USAGE_COUNTER_FILE')
// The worker loop sends capability heartbeats only when the local pipeline is enabled,
// as it is for a real local worker. Set it here so every run measures the same thing.
env.NEXT_PUBLIC_LOCAL_PIPELINE = '1'

/** Wait for the given number of milliseconds. */
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

/** Call the Auth emulator's REST API with its admin credential. */
async function authEmulator(path: string, body: unknown) {
  const response = await fetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/${path}`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  )
  return { ok: response.ok, body: await response.json() }
}

/**
 * Create the owner account and membership in the emulators, plus a worker token for the
 * local pipeline scope. Every write goes to the emulators.
 */
async function seed(db: Firestore) {
  for (const member of sharedDraft ? [owner, editor] : [owner]) {
    const created = await authEmulator(`projects/${project}/accounts`, {
      localId: member.uid,
      email: member.email,
      password,
    })
    if (!created.ok)
      await authEmulator(`projects/${project}/accounts:update`, {
        localId: member.uid,
        password,
      })
    await db.doc(`members/${encodeURIComponent(member.email)}`).set({
      email: member.email,
      role: member.role,
      signIn: 'password',
      status: 'active',
      invite: null,
      uid: member.uid,
      invitedBy: null,
      createdAt: new Date().toISOString(),
      authorityEpoch: 1,
    })
  }
  const store = firestoreJobsStore(db, localJobsEnvironment(scope))
  const token = randomUUID()
  await store.createToken({
    hash: createHash('sha256').update(token).digest('hex'),
    env: store.env,
    workerId: `local-pipeline-${scope}`,
    createdAt: Date.now(),
    revokedAt: null,
  })
  return token
}

/** Sign in through the Auth emulator and return an ID token for API calls. */
async function idToken(account = owner) {
  const response = await fetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: account.email,
        password,
        returnSecureToken: true,
      }),
    }
  )
  const body = (await response.json()) as { idToken?: string }
  if (!body.idToken) throw new Error('Emulator sign-in failed')
  return body.idToken
}

/**
 * Read the server's running totals, waiting for a flush newer than `after`. The server
 * rewrites the file every two seconds, so its modification time says how fresh it is
 * even when nothing was counted (`updatedAt` moves only when a count changes).
 */
async function readCounts(after = 0): Promise<UsageCounts> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if ((await stat(counterFile)).mtimeMs >= after)
        return JSON.parse(await readFile(counterFile, 'utf8'))
    } catch {
      // Not written yet, or caught mid-rename.
    }
    await sleep(1000)
  }
  throw new Error('The dev server is not writing usage counts')
}

/** Subtract one snapshot of a counter table from a later one. */
function diff(later: Record<string, number>, earlier: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(later)
      .map(([key, value]) => [key, value - (earlier[key] ?? 0)] as const)
      .filter(([, value]) => value > 0)
  )
}

/** List the app's route patterns from the file system, such as `/api/batches/[id]`. */
async function routePatterns(directory = 'app'): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await routePatterns(path)))
    else if (/^(route\.(ts|js)|page\.tsx)$/.test(entry.name))
      found.push(
        `/${relative('app', directory)}`
          .replace(/\/\([^)]+\)/g, '')
          .replace(/\/$/, '') || '/'
      )
  }
  return found
}

/** Map a request path to its route pattern, preferring the most specific match. */
function normalize(path: string, patterns: string[]) {
  const parts = path.split('/').filter(Boolean)
  let best: { pattern: string; score: number } | null = null
  for (const pattern of patterns) {
    const segments = pattern.split('/').filter(Boolean)
    if (segments.length !== parts.length) continue
    let score = 0
    const matches = segments.every((segment, index) => {
      if (/^\[.+\]$/.test(segment)) return true
      score++
      return segment === parts[index]
    })
    if (matches && (!best || score > best.score)) best = { pattern, score }
  }
  return best?.pattern ?? path
}

/** Group a route table by route pattern and scale it to one hour. */
function perHour(
  table: Record<string, number>,
  patterns: string[],
  observedMs: number
) {
  const grouped: Record<string, number> = {}
  for (const [key, count] of Object.entries(table)) {
    const [method, path, rsc] = key.split(' ')
    const name = `${method} ${normalize(path, patterns)}${rsc ? ` ${rsc}` : ''}`
    grouped[name] = (grouped[name] ?? 0) + count
  }
  const scale = 3_600_000 / observedMs
  return Object.fromEntries(
    Object.entries(grouped)
      .sort(([, a], [, b]) => b - a)
      .map(([key, count]) => [
        key,
        { observed: count, perHour: Math.round(count * scale) },
      ])
  )
}

/** Build a scripted worker that reports fake tags and descriptions after a delay. */
function fakeWorker(
  token: string,
  stop: { stopped: boolean },
  progress: string[]
) {
  const deps: WorkerDeps = {
    apiBase: base,
    token,
    /** Stop the worker loop by answering as if its token were revoked. */
    fetch: async (url, init) => {
      if (stop.stopped) return new Response(null, { status: 401 })
      const response = await fetch(url, init)
      if (String(url).endsWith('/report') && response.ok)
        progress.push(new Date().toISOString())
      return response
    },
    adapter: {
      backend: 'measurement',
      model: 'fake-tags',
      promptVersion: 'measurement',
      /** Return fixed tags after the configured delay. */
      async suggest() {
        await sleep(jobMs)
        return { tags: ['measurement'] }
      },
    },
    /** Return a fixed description with a source after the configured delay. */
    async suggestFields({ stage, plate }) {
      await sleep(jobMs)
      return {
        fieldSuggestion: {
          kind: 'fields',
          stage,
          fields: {
            description: `Measurement description for ${plate.displayName}.`,
          },
          sources: ['https://example.com/measurement'],
        },
        backend: 'measurement',
        model: 'fake-fields',
        promptVersion: 'measurement',
      }
    },
    readImage: async () => '',
    now: Date.now,
    sleep,
    log: (event) => console.log(`[worker] ${event}`),
    capabilities: {
      group: { available: false, reason: 'Measurement worker' },
      embeddings: { available: false, reason: 'Measurement worker' },
      mask: { available: false, reason: 'Measurement worker' },
      vision: { available: true },
      pollIntervalMs: 5000,
    },
  }
  return runLoop(deps, { idleMs: 5000, concurrency: 1 })
}

/** Run the scenario and write the results. */
async function main() {
  const { chromium } = require(env.PLAYWRIGHT_MODULE || 'playwright')
  const db = new Firestore({ projectId: project })
  const workerToken = await seed(db)
  const patterns = await routePatterns()
  const catalog = JSON.parse(
    await readFile('fixtures/catalog-demo.json', 'utf8')
  ) as { plates: { id: string; state: string }[] }
  const plateCount = sharedDraft ? 3 : 40
  const plateIds = catalog.plates
    .filter((plate) => plate.state === 'AK')
    .slice(0, plateCount)
    .map((plate) => plate.id)
  if (plateIds.length !== plateCount)
    throw new Error(`Need ${plateCount} Alaska fixture plates`)

  const browser = await chromium.launch({ headless: true })
  const editorBrowser = sharedDraft
    ? await chromium.launch({ headless: true })
    : null
  const stop = { stopped: false }
  const progress: string[] = []
  let worker: Promise<void> | undefined
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    })
    const editorPage = await editorBrowser?.newPage({
      viewport: { width: 1440, height: 1000 },
    })
    const browserRequests: Record<string, number> = {}
    const draftReads = { owner: 0, editor: 0 }
    let counting = false
    function countRequest(page: typeof editorPage, role: 'owner' | 'editor') {
      page?.on('request', (request: { url(): string; method(): string }) => {
        const url = new URL(request.url())
        if (!counting || url.origin !== new URL(base).origin) return
        if (url.pathname.startsWith('/_next/static')) return
        const key = `${request.method()} ${url.pathname}`
        browserRequests[key] = (browserRequests[key] ?? 0) + 1
        if (
          request.method() === 'GET' &&
          url.searchParams.has('catalogVersion') &&
          url.pathname === '/api/batches' &&
          url.searchParams.has('dashboard')
        )
          draftReads[role]++
      })
    }
    countRequest(page, 'owner')
    countRequest(editorPage, 'editor')
    async function signIn(page: typeof editorPage, account: typeof owner) {
      await page.goto(new URL('/sign-in', base).href)
      await page.locator('#email').fill(account.email)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.locator('#password').fill(password)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await page.waitForURL((url: URL) => url.pathname !== '/sign-in', {
        timeout: 60000,
      })
    }
    await signIn(page, owner)
    await page.goto(new URL('/states/AK', base).href)
    await page
      .locator('article[data-drag-family^="AK."]')
      .first()
      .waitFor({ timeout: 120000 })
    await page.getByRole('button', { name: 'Open Plate Pipeline' }).click()
    await page.locator('[data-pipeline-drawer]').waitFor({ timeout: 60000 })
    const editedPlate = sharedDraft
      ? await page
          .locator('[data-plate-row^="AK."]')
          .first()
          .getAttribute('data-plate-row')
      : null
    if (editorPage) {
      await signIn(editorPage, editor)
      await editorPage.goto(new URL('/states/AK', base).href)
      await editorPage.locator('[data-plate-row^="AK."]').first().waitFor({
        state: 'attached',
      })
    }
    await sleep(5000)

    const before = await readCounts(Date.now())
    if (before.projectId !== project || !before.firestoreEmulator)
      throw new Error('The dev server is not using the demo project emulator')
    counting = true
    const startedAt = Date.now()
    console.log(`[usage] observing for ${minutes} minutes`)
    let draftMeasurement
    if (editorPage && editedPlate) {
      await sleep(8_000)
      const idleReads = { ...draftReads }
      const edit = await idToken(editor)
      const plate = await fetch(`${base}/api/plates/${editedPlate}`, {
        headers: { Authorization: `Bearer ${edit}` },
      }).then((response) => response.json())
      if (!plate.plate?.revision)
        throw new Error('Missing fixture plate revision')
      const saved = await fetch(
        `${base}/api/batches/draft/plates/${editedPlate}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${edit}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            baseRevision: plate.plate.revision,
            fields: { tags: ['shared-draft-measurement'] },
          }),
        }
      )
      if (!saved.ok) throw new Error(`Editor save failed: ${saved.status}`)
      const savedAt = Date.now()
      const marker = `[data-plate-row="${editedPlate}"] [data-batch-marker]`
      await page.locator(marker).waitFor({ timeout: 10_000 })
      const ownerLagMs = Date.now() - savedAt
      await editorPage.locator(marker).waitFor({ timeout: 10_000 })
      draftMeasurement = {
        idleReads,
        idleMs: 8000,
        ownerLagMs,
        editorSaveReads: {
          owner: draftReads.owner - idleReads.owner,
          editor: draftReads.editor - idleReads.editor,
        },
      }
      console.log('[usage] Editor save appeared in both Dashboards')
    }
    worker = fakeWorker(workerToken, stop, progress)

    if (!idle) await queueRun()

    /** Queue the first 40 plates for tag and describe once the warm-up has passed. */
    async function queueRun() {
      await sleep(runAtSeconds * 1000)
      const enqueue = await fetch(`${base}/api/local-pipeline/runs/selection`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await idToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          batchName: 'AK measurement',
          requestId: randomUUID(),
          plateIds,
          stages: ['tag', 'describe'],
          options: {},
        }),
      })
      if (!enqueue.ok)
        throw new Error(
          `Enqueue failed: ${enqueue.status} ${await enqueue.text()}`
        )
      console.log(`[usage] enqueued ${plateCount} plates (tag and describe)`)
    }

    const end = startedAt + minutes * 60_000
    while (Date.now() < end) {
      await sleep(Math.min(60_000, end - Date.now()))
      console.log(
        `[usage] ${Math.round((Date.now() - startedAt) / 1000)}s, ${progress.length} results reported`
      )
    }
    counting = false
    const after = await readCounts(Date.now())
    const observedMs = Date.now() - startedAt
    const client = await page.evaluate(
      () =>
        (window as unknown as { __curatorUsage?: unknown }).__curatorUsage ??
        null
    )
    stop.stopped = true

    const routes = diff(after.routes, before.routes)
    const firestore = {
      documentReads: diff(
        after.firestore.documentReads,
        before.firestore.documentReads
      ),
      queries: diff(after.firestore.queries, before.firestore.queries),
      writes: diff(after.firestore.writes, before.firestore.writes),
    }
    /** Sum a counter table. */
    const total = (table: Record<string, number>) =>
      Object.values(table).reduce((sum, value) => sum + value, 0)
    const scale = 3_600_000 / observedMs
    const result = {
      label,
      scenario: idle ? 'idle' : 'run',
      measuredAt: new Date(startedAt).toISOString(),
      observedMinutes: Math.round(observedMs / 6000) / 10,
      jobsReported: progress.length,
      routes: perHour(routes, patterns, observedMs),
      browserRequests: perHour(browserRequests, patterns, observedMs),
      ...(draftMeasurement && {
        sharedDraft: {
          ...draftMeasurement,
          totalReads: draftReads,
          draftRunReads: {
            owner:
              draftReads.owner -
              draftMeasurement.idleReads.owner -
              draftMeasurement.editorSaveReads.owner,
            editor:
              draftReads.editor -
              draftMeasurement.idleReads.editor -
              draftMeasurement.editorSaveReads.editor,
          },
        },
      }),
      firestore,
      client,
      totals: {
        requestsPerHour: Math.round(total(routes) * scale),
        browserRequestsPerHour: Math.round(total(browserRequests) * scale),
        documentReadsPerHour: Math.round(
          total(firestore.documentReads) * scale
        ),
        queriesPerHour: Math.round(total(firestore.queries) * scale),
        writesPerHour: Math.round(total(firestore.writes) * scale),
      },
    }
    await mkdir(output, { recursive: true })
    const file = join(output, `${label}.json`)
    await writeFile(file, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result.totals))
    console.log(`[usage] wrote ${file}`)
  } finally {
    stop.stopped = true
    await Promise.all([browser.close(), editorBrowser?.close()])
    await Promise.race([worker, sleep(15000)])
    await db.terminate()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
