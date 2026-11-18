import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'
import { usePipelineQueue } from '../../components/dashboard/use-pipeline-queue'
import { PipelineQueuePanel } from '../../components/dashboard/pipeline-queue-panel'
import type { QueueRunView } from '../../lib/jobs/queue-types'
import { PipelineRunControls } from '../../components/dashboard/pipeline-run-controls'
import { TAGGING_MODELS } from '../../lib/tagging/models'
import { PipelineFieldValue, pipelineFieldLabel } from '../../components/dashboard/pipeline-field-value'
import { imageGroupCapabilities } from '../../lib/jobs/image-options'
import { PipelineRunCard } from '../../components/dashboard/pipeline-run-card'
import { PipelineRuns } from '../../components/dashboard/pipeline-runs'
import { queueProgress } from '../../lib/jobs/run-progress'

const mocks = vi.hoisted(() => ({ api: { get: vi.fn(), send: vi.fn() }, ensure: vi.fn(),
  models: [] as (typeof TAGGING_MODELS)[number][], workspace: { mode: 'personal' } as { mode: string; id?: string; status?: string; detail?: { batch: { state: string } } } }))
vi.mock('../../lib/client/session', () => ({ useSession: () => ({ user: { uid: 'editor' }, api: mocks.api }) }))
vi.mock('../../lib/client/hooks', () => ({ useEnsureBatch: () => mocks.ensure, useWorkspaceBatch: () => mocks.workspace, useMe: () => ({ data: { uid: 'editor', name: 'Editor' } }) }))
vi.mock('../../components/dashboard/tagging-model-picker', () => ({ useTaggingModelChoice: () => ({ data: { models: mocks.models }, modelId: 'desktop-gemma4-12b' }), TaggingModelPicker: () => <span>Local model</span> }))
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
  mocks.models = [...TAGGING_MODELS]
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
  const completed = saved({ id: 'completed', status: 'completed', previewOnly: false })
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
  await waitFor(() => expect(enqueue).toHaveBeenCalledWith([plate], ['describe', 'story', 'tag'], 'desktop-gemma4-12b', { story: { redoExisting: false }, tag: { onlyUnderTagged: false } }, true))
})

test('Preview hides every run Apply control and explains that a normal rerun is required', () => {
  const run = saved({ status: 'completed', previewOnly: true })
  render(<PipelineQueuePanel queue={{ runs: [run], selected: run, select: vi.fn(), loading: false, error: null, refresh: vi.fn(), action: null,
    message: '', cancel: vi.fn(), retry: vi.fn(), apply: vi.fn(), chooseImage: vi.fn(), recover: vi.fn() }} />)
  expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull()
  expect(screen.getByText(/Run again without Preview only/)).toBeTruthy()
})

test('each specialized image result names its plate in a multi-plate completed Preview', () => {
  const plates = ['One', 'Two'].map(name => ({ id: `AK.${name.toLowerCase()}`, slug: name.toLowerCase(), state: 'AK', image: '', displayName: name, tags: [] }))
  const candidate = { id: 'photo', title: 'Photo', imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Plate.jpg', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Plate.jpg', width: 640, height: 320, sha256: 'a'.repeat(64) }
  const run = saved({ status: 'completed', previewOnly: true, plateIds: plates.map(plate => plate.id) })
  run.attempts[0].projection = { baselineVersion: 1, plates: Object.fromEntries(plates.map(plate => [plate.id, { batchInput: plate, executionPlate: plate, batchInputHash: 'hash', executionHash: 'hash', sourceJobIds: [] }])) }
  run.jobs = plates.map(plate => ({ id: `image-${plate.id}`, batchId: 'batch', plateId: plate.id, requestedBy: 'editor', env: run.env, inputHash: 'hash', state: 'completed', createdAt: 100,
    result: { suggestions: [], fieldSuggestion: { kind: 'image', stage: 'find-image', candidates: [candidate], sources: [candidate.imageUrl, candidate.sourceUrl] }, backend: 'fixture', model: 'fixture', promptVersion: 'v1', durationMs: 0 } }))
  render(<PipelineQueuePanel queue={{ runs: [run], selected: run, select: vi.fn(), loading: false, error: null, refresh: vi.fn(), action: null, message: '', cancel: vi.fn(), retry: vi.fn(), apply: vi.fn(), chooseImage: vi.fn(), recover: vi.fn() }} />)
  expect(screen.getByRole('heading', { name: 'Image for One · AK' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Image for Two · AK' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull()
})

test('model-free Wiki plus skipped Story can start without any desktop model', async () => {
  mocks.models = TAGGING_MODELS.filter(model => model.runsOn === 'gateway')
  const enqueue = vi.fn().mockResolvedValue(saved())
  const existing = { ...plate, hasStory: true }
  render(<PipelineRunControls underTagged={[existing]} batchPlates={[existing]} stateName="Alaska" queue={{ runs: [], action: null, message: '', disabledReason: undefined, enqueue }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Tag' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Wiki link' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Story' }))
  expect((screen.getByRole('button', { name: 'Start run' }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.queryByText('Local model')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  await waitFor(() => expect(enqueue).toHaveBeenCalledWith([existing], ['wiki-link', 'story'], undefined, { story: { redoExisting: false } }, false))
})

test('worker capabilities enable Group and normalize unsupported default colour signal OFF; Preview ignores standalone capability', async () => {
  const enqueue = vi.fn().mockResolvedValue(saved())
  const capabilities = { ...imageGroupCapabilities({ embeddings: true, backgroundMask: false, visionTiebreak: false, maskReason: 'Mask unavailable' }), reportedAt: 100, pollIntervalMs: 1000 }
  render(<PipelineRunControls underTagged={[plate]} batchPlates={[plate]} stateName="Alaska" queue={{ runs: [], action: null, message: '', disabledReason: undefined, enqueue, capabilities }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Group' }))
  const colour = screen.getByLabelText(/Use colour signal/) as HTMLInputElement
  expect(colour.checked).toBe(false)
  expect(colour.disabled).toBe(true)
  expect((screen.getByLabelText(/Preview only/) as HTMLInputElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  await waitFor(() => expect(enqueue).toHaveBeenCalledWith([plate], ['tag', 'group'], 'desktop-gemma4-12b', {
    tag: { onlyUnderTagged: false }, group: { method: 'embeddings', colorSignal: false, backgroundMask: false, visionTiebreak: false },
  }, false))
})

test('Preview never bootstraps or changes Batch metadata; it uses an existing Batch context', async () => {
  const missing = renderHook(() => usePipelineQueue(), { wrapper })
  await act(async () => { await missing.result.current.enqueue([plate], ['tag'], undefined, {}, true) })
  expect(mocks.ensure).not.toHaveBeenCalled()
  expect(mocks.api.send).not.toHaveBeenCalled()
  expect(missing.result.current.message).toBe('Preview requires an existing open Batch.')
  missing.unmount()
  const existing = renderHook(() => usePipelineQueue('existing-batch'), { wrapper })
  await act(async () => { await existing.result.current.enqueue([plate], ['tag'], undefined, {}, true) })
  expect(mocks.ensure).not.toHaveBeenCalled()
  expect(mocks.api.send).toHaveBeenCalledWith('POST', '/api/local-pipeline/runs', expect.objectContaining({ batchId: 'existing-batch', previewOnly: true }))
})

test('run cards show a failed Wiki step, cancelled dependants, duration, and a real Visibility link', () => {
  const run = saved({ status: 'failed', stages: ['wiki-link', 'describe', 'story'] })
  run.attempts[0] = { ...run.attempts[0], status: 'failed', endedAt: 33100, workflowId: 'wrun_real', workflowUrl: 'https://vercel.com/memoriuhl/plate-curator-vercel/workflows/runs/wrun_real?environment=preview', steps: [
    { index: 0, plateId: 'AK.one', stage: 'wiki-link', resourceClass: 'io', status: 'failed', startedAt: 100, endedAt: 33100, reason: 'no_sources' },
    { index: 1, plateId: 'AK.one', stage: 'describe', resourceClass: 'gpu', status: 'cancelled', reason: 'upstream_failed' },
    { index: 2, plateId: 'AK.one', stage: 'story', resourceClass: 'gpu', status: 'cancelled', reason: 'upstream_failed' },
  ] }
  render(<PipelineRunCard run={run} stages={run.stages} progress={queueProgress(run)} observedAt={99999} requester="Editor" />)
  expect(screen.getByRole('button', { name: /Wiki link: Failed · 00:33/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Describe: Cancelled · not run/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Story: Cancelled · not run/ })).toBeTruthy()
  const link = screen.getByRole('link', { name: 'View workflow for run saved-run' })
  expect(link.getAttribute('href')).toBe(run.attempts[0].workflowUrl)
  expect(link.getAttribute('target')).toBe('_blank')
  expect(screen.queryByRole('progressbar')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Describe: Cancelled/ }))
  expect(screen.getByText('An earlier step failed. This step did not run.')).toBeTruthy()
  expect(screen.queryByText('Workflow run')).toBeNull()
})

test('execution dropdown switches local workers and gateway views without mutating or restarting runs', async () => {
  const local = saved()
  local.progress = { ...queueProgress(local), workerIds: ['Studio PC', 'Laptop'] }
  mocks.api.get.mockImplementation(async (path: string) => path.startsWith('/api/local-pipeline') ? { runs: [local], observedAt: 1000 } : { runs: [{
    id: 'gateway-run', batchId: 'batch', requestedBy: 'editor', plateIds: ['AK.one'], modelId: 'gateway-gemma4-26b', createdAt: 100, status: 'completed',
    progress: { workerIds: [], endedAt: 800, steps: [{ index: 0, plateId: 'AK.one', plateName: 'One', stage: 'tag', status: 'completed', durationMs: 700 }], workflowUrl: null }, results: [],
  }], observedAt: 1000 })
  function Runs() { return <PipelineRuns queue={usePipelineQueue()} /> }
  render(<Runs />, { wrapper })
  await waitFor(() => expect(screen.getByRole('article', { name: 'Pipeline run saved-run' })).toBeTruthy())
  fireEvent.keyDown(screen.getByRole('button', { name: /View runs: Local PC/ }), { key: 'Enter' })
  await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'Studio PC' })).toBeTruthy())
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Vercel Gateway/ }))
  await waitFor(() => expect(screen.getByRole('article', { name: 'Pipeline run gateway-run' })).toBeTruthy())
  expect(screen.queryByRole('article', { name: 'Pipeline run saved-run' })).toBeNull()
  expect(screen.getByRole('button', { name: /View runs: Vercel Gateway. Gemma 4 26B/ })).toBeTruthy()
  expect(mocks.api.send).not.toHaveBeenCalled()
})

test('coherent facts and read-more links use readable text and cited links instead of raw JSON', () => {
  expect(pipelineFieldLabel('funFacts')).toBe('Fun facts')
  expect(pipelineFieldLabel('firstIssuedYear')).toBe('First issued')
  render(<><PipelineFieldValue field="funFacts" value={[{ text: 'This design was first issued in 1976.', sourceUrl: 'https://example.org/fact', sourceTitle: 'Issuing authority' }]} />
    <PipelineFieldValue field="readMore" value={[{ title: 'Design history', site: 'Museum', url: 'https://example.org/history' }]} />
    <PipelineFieldValue field="tags" value={['blue', 'graphic']} /></>)
  expect(screen.getByText('This design was first issued in 1976.')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Issuing authority' }).getAttribute('href')).toBe('https://example.org/fact')
  expect(screen.getByRole('link', { name: 'Design history' }).getAttribute('href')).toBe('https://example.org/history')
  expect(screen.getByText('Museum')).toBeTruthy()
  expect(screen.queryByText(/"sourceUrl"/)).toBeNull()
})
