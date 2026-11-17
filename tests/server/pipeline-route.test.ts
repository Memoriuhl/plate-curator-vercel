import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ actor: vi.fn(), choose: vi.fn(), validate: vi.fn(), start: vi.fn() }))
vi.mock('workflow/api', () => ({ start: mocks.start }))
vi.mock('../../lib/server/context', () => ({ currentActor: mocks.actor, chooseModel: mocks.choose, reviewDeps: () => ({}) }))
vi.mock('../../lib/review/tagging', () => ({ validateTagging: mocks.validate }))
vi.mock('../../workflows/pipeline', () => ({ pipelineRun: vi.fn() }))
const { POST } = await import('../../app/api/batches/[id]/plates/[plateId]/pipeline/route')
const ctx = { params: Promise.resolve({ id: 'own-batch', plateId: 'AK.one' }) }
const request = (body: unknown) => new Request('http://localhost/api/batches/own-batch/plates/AK.one/pipeline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
beforeEach(() => {
  vi.stubEnv('LOCAL_PIPELINE_SCOPE', 'route-test')
  mocks.actor.mockReset().mockResolvedValue({ ok: true, actor: { uid: 'editor', role: 'editor' } })
  mocks.choose.mockReset().mockReturnValue({ ok: true, model: { id: 'desktop-gemma4-12b', runsOn: 'desktop' } })
  mocks.validate.mockReset().mockResolvedValue({ ok: true })
  mocks.start.mockReset().mockResolvedValue({ runId: 'run' })
})
afterEach(() => vi.unstubAllEnvs())

test.each([undefined, '', 'invalid/scope'])('missing or invalid local scope fails before any workflow starts: %s', async scope => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  vi.stubEnv('LOCAL_PIPELINE_SCOPE', scope)
  expect((await POST(request({ stage: 'story' }), ctx)).status).toBe(404)
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.actor).not.toHaveBeenCalled()
})

test('pipeline route is absent without the local flag', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  expect((await POST(request({ stage: 'describe' }), ctx)).status).toBe(404)
  expect(mocks.actor).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

test('validates the actor, stage, local model and Batch ownership before starting a job', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const response = await POST(request({ stage: 'describe', model: 'desktop-gemma4-12b' }), ctx)
  expect(response.status).toBe(202)
  expect(mocks.choose).toHaveBeenCalledWith('desktop-gemma4-12b', 'desktop')
  expect(mocks.validate).toHaveBeenCalledWith({}, { uid: 'editor', role: 'editor' }, 'own-batch', 'AK.one')
  expect(mocks.start.mock.calls[0][1]).toEqual([expect.any(String), 'own-batch', 'AK.one', 'editor', 'describe', 'desktop-gemma4-12b'])
  expect((await POST(request({ stage: 'order' }), ctx)).status).toBe(400)
  mocks.validate.mockResolvedValueOnce({ ok: false, error: 'forbidden' })
  expect((await POST(request({ stage: 'story' }), ctx)).status).toBe(403)
  expect(mocks.start).toHaveBeenCalledTimes(1)
})
