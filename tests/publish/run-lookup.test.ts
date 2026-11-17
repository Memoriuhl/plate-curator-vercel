import { beforeEach, expect, test, vi } from 'vitest'
import { HookNotFoundError, WorkflowRunNotFoundError } from 'workflow/errors'
import { workflowPublishRunLookup } from '../../lib/server/publish-runs'

const mocks = vi.hoisted(() => ({ getRun: vi.fn(), getHookByToken: vi.fn() }))
vi.mock('workflow/api', () => mocks)
beforeEach(() => vi.resetAllMocks())

test('WorkflowRunNotFoundError is classified explicitly while transient errors are retained', async () => {
  const lookup = workflowPublishRunLookup()
  mocks.getRun.mockImplementationOnce(() => { throw new WorkflowRunNotFoundError('purged') })
  expect(await lookup.runStatus!('purged')).toBe('not_found')
  mocks.getRun.mockImplementationOnce(() => { throw new Error('temporary') })
  await expect(lookup.runStatus!('live')).rejects.toThrow('temporary')
})

test('token absence differs from a retained token whose run was purged', async () => {
  const lookup = workflowPublishRunLookup()
  mocks.getHookByToken.mockRejectedValueOnce(new HookNotFoundError('missing')).mockResolvedValueOnce({ runId: 'purged' })
  expect(await lookup.findRun!('missing')).toBeNull()
  mocks.getRun.mockImplementationOnce(() => { throw new WorkflowRunNotFoundError('purged') })
  expect(await lookup.findRun!('retained')).toEqual({ runId: 'purged', status: 'not_found' })
})
