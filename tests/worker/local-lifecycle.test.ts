import { afterEach, expect, test, vi } from 'vitest'
import { runOnce, type WorkerDeps } from '../../worker/run'

function setup(local = true) {
  let time = 100
  const claim = { local, queueRunId: 'run', job: { id: 'job' }, claimId: 'claim', leaseExpiresAt: new Date(10000).toISOString(),
    plate: { image: 'old.webp', imageUrl: 'https://example.org/image.webp', displayName: 'One', state: 'AK', tags: [] }, stage: 'describe' as 'describe' | undefined }
  const calls: { path: string; body: unknown }[] = []
  const deps: WorkerDeps = { apiBase: 'https://example.org', token: 'fixture', fetch: vi.fn(async (path, init) => {
    calls.push({ path: String(path), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(String(path).endsWith('/claim') ? claim : {}), { status: 200 })
  }), adapter: { backend: 'test', model: 'fixture', promptVersion: 'v1', suggest: vi.fn(async () => ({ tags: [] })) },
    readImage: vi.fn(async () => ''), now: () => time, sleep: async () => undefined, log: vi.fn() }
  return { claim, deps, calls, advance: (ms: number) => { time += ms } }
}

afterEach(() => vi.unstubAllEnvs())

test('Tag overrides require BOTH a local claim and the local flag; every legacy case keeps the asset path', async () => {
  for (const [local, flag, expected] of [[true, '1', 'https://example.org/image.webp'], [true, '0', 'old.webp'], [false, '1', 'old.webp'], [false, '0', 'old.webp']] as const) {
    vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', flag)
    const s = setup(local)
    s.claim.stage = undefined
    expect(await runOnce(s.deps)).toBe('reported')
    expect(s.deps.readImage).toHaveBeenCalledWith(expected)
  }
})

test('local stage with no handler explicitly fails and production behavior remains unchanged', async () => {
  const s = setup()
  expect(await runOnce(s.deps)).toBe('dropped')
  expect(s.calls.at(-1)).toMatchObject({ path: 'https://example.org/api/worker/jobs/job/fail', body: { claimId: 'claim', error: 'no_handler' } })
  const production = setup(false)
  expect(await runOnce(production.deps)).toBe('dropped')
  expect(production.calls).toHaveLength(1)
})

test('failure acknowledgement occurs only after the handler returns/throws, including expired stages', async () => {
  const s = setup()
  let ended = false
  s.deps.suggestFields = async () => { s.advance(20000); ended = true; throw Error('Handler failed') }
  const fetch = s.deps.fetch
  s.deps.fetch = async (path, init) => {
    if (String(path).endsWith('/fail')) expect(ended).toBe(true)
    return fetch(path, init)
  }
  await expect(runOnce(s.deps)).rejects.toThrow('Handler failed')
  expect(s.calls.at(-1)?.body).toMatchObject({ error: 'stage_failed' })
})

test('successful typed reports do not send failure and semantic no-result stays explicit', async () => {
  const s = setup()
  s.deps.suggestFields = async () => ({ stageError: 'no_sources', backend: 'fixture', model: 'test', promptVersion: 'v1' })
  expect(await runOnce(s.deps)).toBe('reported')
  expect(s.calls.at(-1)?.path).toContain('/report')
  expect(s.calls.at(-1)?.body).toMatchObject({ stageError: 'no_sources' })
  expect(s.calls.some(call => call.path.endsWith('/fail'))).toBe(false)
})
