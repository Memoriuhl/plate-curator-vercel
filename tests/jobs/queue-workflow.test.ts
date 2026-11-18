import { beforeEach, expect, test, vi } from 'vitest'
import { localPipelineRun } from '../../workflows/local-pipeline'

const mocks = vi.hoisted(() => ({ bind: vi.fn(), dispatch: vi.fn(), observe: vi.fn(), conflict: vi.fn(), sleep: vi.fn(), events: [] as string[] }))
vi.mock('../../lib/jobs/queue-hosted', () => ({ executeHostedQueueStage: async () => 'settled' }))
vi.mock('../../lib/server/context', () => ({ jobsDeps: () => ({}), hostedTaggingDeps: vi.fn() }))
vi.mock('../../lib/jobs/queue-engine', () => ({ bindQueueWorkflow: mocks.bind, dispatchQueueStage: mocks.dispatch, observeQueueStage: mocks.observe }))
vi.mock('workflow', () => ({
  getWorkflowMetadata: () => ({ workflowRunId: 'workflow' }),
  createHook: ({ token }: { token: string }) => ({ token, getConflict: mocks.conflict, [Symbol.dispose]() {},
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }),
  sleep: mocks.sleep,
}))

beforeEach(() => {
  vi.clearAllMocks(); mocks.events = []
  mocks.bind.mockResolvedValue(true)
  mocks.conflict.mockImplementation(async () => { mocks.events.push('hook_registered'); return null })
  mocks.dispatch.mockImplementation(async () => { mocks.events.push('dispatch'); return 'job' })
  mocks.observe.mockResolvedValue({ phase: 'next' })
  mocks.sleep.mockResolvedValue(undefined)
})

test('each unique attempt/stage hook is registered before dispatch and completed jobs reconcile without callback', async () => {
  expect(await localPipelineRun('run', 2, 1, 3)).toEqual({ outcome: 'completed' })
  expect(mocks.events).toEqual(['hook_registered', 'dispatch', 'hook_registered', 'dispatch'])
  expect(mocks.dispatch.mock.calls.map(args => args.slice(1))).toEqual([
    ['run', 2, 1, 'local-pipeline:run:2:1'], ['run', 2, 2, 'local-pipeline:run:2:2'],
  ])
})

test('hook conflict or superseded coordinator cannot dispatch a job', async () => {
  mocks.conflict.mockResolvedValue({ runId: 'other' })
  expect(await localPipelineRun('run', 1, 0, 1)).toEqual({ outcome: 'hook_conflict' })
  expect(mocks.dispatch).not.toHaveBeenCalled()
  mocks.bind.mockResolvedValue(false)
  expect(await localPipelineRun('run', 1, 0, 1)).toEqual({ outcome: 'superseded' })
})

test('queue/offline wait uses a long durable wait and only claimed inference gets its own lease deadline', async () => {
  mocks.observe.mockResolvedValueOnce({ phase: 'waiting' }).mockResolvedValueOnce({ phase: 'claimed', deadline: 12345 }).mockResolvedValueOnce({ phase: 'next' })
  expect(await localPipelineRun('run', 1, 0, 1)).toEqual({ outcome: 'completed' })
  expect(mocks.sleep.mock.calls.map(args => args[0])).toEqual(['1h', new Date(12345)])
})
