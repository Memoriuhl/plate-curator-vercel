import { expect, test, vi } from 'vitest'
import { runOnce, runLoop, type WorkerDeps } from '../../worker/run'
import { ollamaAdapter } from '../../worker/model'

const claim = { job: { id: 'j', batchId: 'b', plateId: 'p', inputHash: 'h' }, claimId: 'c', leaseExpiresAt: new Date(60000).toISOString(), plate: { id: 'p', state: 'AK', displayName: 'Bear', image: 'AK/bear.webp', tags: [] } }
function setup(status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json(claim)).mockImplementation(async () => new Response(null, { status }))
  const deps: WorkerDeps = { apiBase: 'http://localhost', token: 'secret', protectionBypass: 'bypass', fetch, adapter: { backend: 'ollama', model: 'test', promptVersion: 'abc', suggest: vi.fn(async () => ({ tags: ['bear'], usage: { eval_count: 2 } })) }, readImage: vi.fn(async () => 'base64'), now: () => 0, sleep: vi.fn(async () => {}), log: vi.fn() }
  return { deps, fetch }
}
test('runOnce reports suggestions with model metadata', async () => {
  const { deps, fetch } = setup()
  expect(await runOnce(deps)).toBe('reported')
  const init = fetch.mock.calls[1][1]!
  expect(JSON.parse(String(init.body))).toEqual({ claimId: 'c', suggestions: ['bear'], backend: 'ollama', model: 'test', promptVersion: 'abc', durationMs: 0, usage: { eval_count: 2 } })
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret')
  expect(new Headers(init.headers).get('x-vercel-protection-bypass')).toBe('bypass')
  expect(fetch.mock.calls[0][1]?.body).toBeUndefined()
})
test('nothing queued returns idle without calling the model', async () => {
  const { deps, fetch } = setup()
  fetch.mockReset().mockResolvedValue(new Response(null, { status: 204 }))
  expect(await runOnce(deps)).toBe('idle')
  expect(deps.adapter.suggest).not.toHaveBeenCalled()
})
test('a 409 report is logged and not retried', async () => {
  const { deps, fetch } = setup(409)
  expect(await runOnce(deps)).toBe('dropped')
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(deps.log).toHaveBeenCalled()
})
test('a 5xx report retries with backoff then gives up', async () => {
  const { deps, fetch } = setup(503)
  expect(await runOnce(deps)).toBe('dropped')
  expect(fetch).toHaveBeenCalledTimes(5)
  expect(vi.mocked(deps.sleep).mock.calls.map(([ms]) => ms)).toEqual([500, 1000, 2000])
})
test('401 stops the loop', async () => {
  const { deps, fetch } = setup(401)
  await runLoop(deps, { idleMs: 5 })
  expect(fetch).toHaveBeenCalledTimes(2)
})
test('missing image reports an empty list with backend missing-image', async () => {
  const { deps, fetch } = setup()
  vi.mocked(deps.readImage).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  await runOnce(deps)
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toMatchObject({ suggestions: [], backend: 'missing-image' })
  expect(deps.adapter.suggest).not.toHaveBeenCalled()
})
test('adapter flattens structured tags and dedupes', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ message: { content: '```json\n{"primaryColor":"white","colors":["white","invalid"],"textColors":["black"],"subjects":["bears","bear"],"themes":["wildlife"],"motifs":[],"emblemText":["USN"]}\n```' }, eval_count: 4, prompt_eval_count: 7 }))
  const adapter = ollamaAdapter({ url: 'http://localhost:11434/v1', model: 'test', fetch })
  expect(await adapter.suggest({ imageB64: 'image', plate: { displayName: 'Bear Plate', state: 'AK', tags: [] } })).toEqual({ tags: ['white', 'black text', 'wildlife', 'bear', 'usn'], usage: { eval_count: 4, prompt_eval_count: 7 } })
  expect(adapter.promptVersion).toMatch(/^[a-f0-9]{12}$/)
})
test('expired lease prevents report transmission', async () => {
  const { deps, fetch } = setup()
  deps.now = () => 60000
  expect(await runOnce(deps)).toBe('dropped')
  expect(fetch).toHaveBeenCalledTimes(1)
})
test('network report failures retry the identical result', async () => {
  const { deps, fetch } = setup()
  fetch.mockReset().mockResolvedValueOnce(Response.json(claim)).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Response(null, { status: 200 }))
  expect(await runOnce(deps)).toBe('reported')
  expect(fetch.mock.calls[1][1]?.body).toBe(fetch.mock.calls[2][1]?.body)
})
test('401 on claim stops before reading an image', async () => {
  const { deps, fetch } = setup()
  fetch.mockReset().mockResolvedValue(new Response(null, { status: 401 }))
  await runLoop(deps, { idleMs: 5 })
  expect(deps.readImage).not.toHaveBeenCalled()
})
test('a failed iteration logs its cause and keeps going', async () => {
  const { deps, fetch } = setup()
  fetch.mockReset().mockRejectedValueOnce(new Error('connect ECONNREFUSED')).mockResolvedValue(new Response(null, { status: 401 }))
  await runLoop(deps, { idleMs: 5 })
  expect(deps.log).toHaveBeenCalledWith('Worker iteration failed: connect ECONNREFUSED')
})

test('concurrent lanes claim independently, isolate a failing job and report their own leases', async () => {
  const { deps } = setup()
  let claims = 0
  let active = 0
  let maximum = 0
  const reports: { url: string; claimId: string }[] = []
  deps.fetch = vi.fn(async (url, init) => {
    if (String(url).endsWith('/claim')) {
      const id = ++claims
      if (id > 4) return new Response(null, { status: 401 })
      return Response.json({ ...claim, job: { id: `job-${id}` }, claimId: `lease-${id}`, plate: { ...claim.plate, displayName: String(id) } })
    }
    reports.push({ url: String(url), claimId: JSON.parse(String(init?.body)).claimId })
    return new Response(null, { status: 200 })
  })
  deps.adapter.suggest = async ({ plate }) => {
    maximum = Math.max(maximum, ++active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    if (plate.displayName === '1') throw new Error('model unavailable')
    return { tags: ['bear'] }
  }
  await runLoop(deps, { idleMs: 1, concurrency: 4 })
  expect(maximum).toBe(4)
  expect(reports).toHaveLength(3)
  for (const report of reports) expect(report.url).toContain(`/jobs/job-${report.claimId.split('-')[1]}/report`)
  expect(deps.log).toHaveBeenCalledWith('Worker iteration failed: model unavailable')
})
