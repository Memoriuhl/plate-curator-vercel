import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'
import { usePipelineQueue } from '../../components/dashboard/use-pipeline-queue'
import { PipelineQueuePanel } from '../../components/dashboard/pipeline-queue-panel'
import type { QueueRunView } from '../../lib/jobs/queue-types'
import { PipelineRunControls } from '../../components/dashboard/pipeline-run-controls'
import { TAGGING_MODELS } from '../../lib/tagging/models'

const mocks = vi.hoisted(() => ({ api: { get: vi.fn(), send: vi.fn() }, ensure: vi.fn(),
  workspace: { mode: 'personal' } as { mode: string; id?: string; status?: string; detail?: { batch: { state: string } } } }))
vi.mock('../../lib/client/session', () => ({ useSession: () => ({ user: { uid: 'editor' }, api: mocks.api }) }))
vi.mock('../../lib/client/hooks', () => ({ useEnsureBatch: () => mocks.ensure, useWorkspaceBatch: () => mocks.workspace }))
vi.mock('../../components/dashboard/tagging-model-picker', () => ({ useTaggingModelChoice: () => ({ data: { models: TAGGING_MODELS }, modelId: 'desktop-gemma4-12b' }), TaggingModelPicker: () => <span>Local model</span> }))
vi.mock('../../components/dashboard/plate-selection', () => ({ useSelectedPlates: () => [] }))

function saved(overrides: Partial<QueueRunView> = {}): QueueRunView {
  return { id: 'saved-run', requestId: 'request', fingerprint: 'input', batchId: 'batch', requestedBy: 'editor', env: 'preview:local-pipeline-test', localScope: 'test',
    plateIds: ['AK.one'], stages: ['tag'], options: {}, previewOnly: true, createdAt: 100, queuedAt: 100, enqueueSequence: 1, updatedAt: 100,
    status: 'queued', resourceClass: 'gpu', jobs: [], editable: true, applied: false,
    attempts: [{ number: 1, requestId: 'request', createdAt: 100, status: 'queued', cursor: 0, jobIds: [], completedJobIds: [], choices: {},
      steps: [{ index: 0, plateId: 'AK.one', stage: 'tag', resourceClass: 'gpu' }] }], ...overrides }
}
const plate = { id: 'AK.one', state: 'AK', displayName: 'One', revision: 'hash', tags: [] }
const wrapper = ({ children }: { children: ReactNode }) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>{children}</SWRConfig>
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1'); localStorage.clear(); mocks.workspace = { mode: 'personal' }
  mocks.ensure.mockReset().mockResolvedValue('batch')
  mocks.api.get.mockReset().mockResolvedValue({ runs: [saved()], selected: saved() })
  mocks.api.send.mockReset().mockResolvedValue({ run: saved() })
})
afterEach(() => { cleanup(); vi.unstubAllEnvs() })

test('reload restores saved run via one list, and an active run does not block enqueue', async () => {
  const first = renderHook(usePipelineQueue, { wrapper })
  await waitFor(() => expect(first.result.current.runs[0]?.id).toBe('saved-run'))
  expect(mocks.api.get.mock.calls.every(args => args[0].startsWith('/api/local-pipeline/runs'))).toBe(true)
  await act(async () => { await first.result.current.enqueue([plate], ['tag']) })
  expect(mocks.api.send).toHaveBeenCalledWith('POST', '/api/local-pipeline/runs', expect.objectContaining({ plateIds: ['AK.one'], stages: ['tag'], requestId: expect.any(String) }))
  first.unmount()
  const restored = renderHook(usePipelineQueue, { wrapper })
  await waitFor(() => expect(restored.result.current.selected?.id).toBe('saved-run'))
})

test('uncertain A then B then remount preserves A request ID', async () => {
  mocks.api.send.mockRejectedValue(new Error('Response lost'))
  const first = renderHook(usePipelineQueue, { wrapper })
  await act(async () => { await first.result.current.enqueue([plate], ['tag']) })
  const original = mocks.api.send.mock.calls[0][2].requestId
  await act(async () => { await first.result.current.enqueue([{ ...plate, id: 'AK.two' }], ['tag']) })
  first.unmount()
  const restored = renderHook(usePipelineQueue, { wrapper })
  await act(async () => { await restored.result.current.enqueue([plate], ['tag']) })
  expect(mocks.api.send.mock.calls[2][2].requestId).toBe(original)
})

test('read-only Batch rejects enqueue and flag off disables list requests', async () => {
  mocks.workspace = { mode: 'selected', id: 'batch', status: 'ready', detail: { batch: { state: 'submitted' } } }
  const first = renderHook(usePipelineQueue, { wrapper })
  await act(async () => { await first.result.current.enqueue([plate], ['tag']) })
  expect(mocks.api.send).not.toHaveBeenCalled()
  first.unmount(); mocks.api.get.mockClear(); vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  renderHook(usePipelineQueue, { wrapper })
  expect(mocks.api.get).not.toHaveBeenCalled()
})

test('history exposes coherent Apply, cancel/retry, durable hide, and explicit verified worker recovery', () => {
  const completed = saved({ id: 'completed', status: 'completed' })
  const controls = { runs: [saved(), completed, saved({ id: 'failed', status: 'failed' })], selected: completed, select: vi.fn(), loading: false, error: null,
    refresh: vi.fn(), action: null, message: '', cancel: vi.fn(), retry: vi.fn(), apply: vi.fn(), chooseImage: vi.fn(), recover: vi.fn() }
  const view = render(<PipelineQueuePanel queue={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel remaining stages' })); expect(controls.cancel).toHaveBeenCalledWith('saved-run')
  fireEvent.click(screen.getByRole('button', { name: 'Retry pending stages' })); expect(controls.retry).toHaveBeenCalledWith('failed')
  fireEvent.click(screen.getByRole('button', { name: 'Apply coherent run to your Batch' })); expect(controls.apply).toHaveBeenCalledWith('completed')
  fireEvent.click(screen.getByRole('button', { name: 'Hide results' })); expect(controls.select).toHaveBeenCalledWith('none')
  const stale = saved({ status: 'running', editable: false, waitReason: 'recovery', cancelRequestedAt: 100, jobs: [{ id: 'job', batchId: 'batch', plateId: 'AK.one', requestedBy: 'editor',
    env: 'preview:local-pipeline-test', inputHash: 'hash', state: 'claimed', createdAt: 100, claimId: 'claim', workerId: 'stopped-worker', queueAttempt: 1, queueStep: 0 }] })
  view.rerender(<PipelineQueuePanel queue={{ ...controls, runs: [stale], selected: stale }} />)
  expect(screen.getByText(/Cancellation requested/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Retry pending stages' })).toBeNull()
  fireEvent.click(screen.getByText('Recover a stopped worker'))
  const button = screen.getByRole('button', { name: 'Release verified stopped worker' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(screen.getByLabelText('I verified this worker has stopped'))
  expect(button.disabled).toBe(false)
  fireEvent.click(button); expect(controls.recover).toHaveBeenCalledWith('saved-run', 'job', 'claim')
})

test('local controls select multiple stages, keep options snapshot, and permit Queue while Start is busy', async () => {
  const enqueue = vi.fn().mockResolvedValue(saved())
  render(<PipelineRunControls underTagged={[plate]} batchPlates={[]} allPlates={[plate]} stateName="Alaska" queue={{ runs: [saved({ status: 'running' })], action: null, message: '', disabledReason: undefined, enqueue }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Describe' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Story' }))
  expect((screen.getByRole('button', { name: 'Start run' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Queue run' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByLabelText(/Preview only/))
  fireEvent.click(screen.getByRole('button', { name: 'Queue run' }))
  await waitFor(() => expect(enqueue).toHaveBeenCalledWith([plate], ['describe', 'story', 'tag'], 'desktop-gemma4-12b', {}, true))
})
