import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { TooltipProvider } from '../../components/ui/tooltip'
import type { ReactNode } from 'react'
import { usePipelineQueue } from '../../components/dashboard/use-pipeline-queue'
import { PipelineQueuePanel } from '../../components/dashboard/pipeline-queue-panel'
import type { QueueRunView } from '../../lib/jobs/queue-types'
import { PipelineRunControls } from '../../components/dashboard/pipeline-run-controls'
import { PipelineOptionSelect } from '../../components/dashboard/pipeline-option-select'
import { TAGGING_MODELS } from '../../lib/tagging/models'
import { PipelineFieldValue, pipelineFieldLabel } from '../../components/dashboard/pipeline-field-value'
import { imageGroupCapabilities } from '../../lib/jobs/image-options'
import { PipelineRunCard } from '../../components/dashboard/pipeline-run-card'
import { PipelineRuns } from '../../components/dashboard/pipeline-runs'
import { queueProgress } from '../../lib/jobs/run-progress'
import { RESEARCH_MODELS } from '../../lib/research/models'

const mocks = vi.hoisted(() => ({ api: { get: vi.fn(), send: vi.fn() }, ensure: vi.fn(),
  modelId: 'desktop-gemma4-12b',
  models: [] as (typeof TAGGING_MODELS)[number][], workspace: { mode: 'personal' } as { mode: string; id?: string; status?: string; detail?: { batch: { state: string } } } }))
vi.mock('../../lib/client/session', () => ({ useSession: () => ({ user: { uid: 'editor' }, api: mocks.api }) }))
vi.mock('../../lib/client/hooks', () => ({ useEnsureBatch: () => mocks.ensure, useWorkspaceBatch: () => mocks.workspace, useMe: () => ({ data: { uid: 'editor', name: 'Editor' } }) }))
vi.mock('../../components/dashboard/tagging-model-picker', () => ({ useTaggingModelChoice: () => ({ data: { models: mocks.models }, modelId: mocks.modelId }), TaggingModelPicker: () => <span>Local model</span> }))
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
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1'); localStorage.clear(); mocks.workspace = { mode: 'personal' }
  mocks.ensure.mockReset().mockResolvedValue('batch')
  mocks.models = [...TAGGING_MODELS]
  mocks.modelId = 'desktop-gemma4-12b'
  mocks.api.get.mockReset().mockResolvedValue({ runs: [saved()], selected: saved() })
  mocks.api.send.mockReset().mockResolvedValue({ run: saved() })
})
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

test('reload restores saved run via one list, and an active run does not block enqueue', async () => {
  const first = renderHook(usePipelineQueue, { wrapper })
  await waitFor(() => expect(first.result.current.runs[0]?.id).toBe('saved-run'))
  expect(mocks.api.get.mock.calls.every(args => args[0].startsWith('/api/local-pipeline/runs'))).toBe(true)
  await act(async () => { await first.result.current.enqueue([plate], ['tag']) })
  expect(mocks.api.send).toHaveBeenCalledWith('POST', '/api/local-pipeline/runs/selection', expect.objectContaining({ batchName: 'AK pipeline', plateIds: ['AK.one'], stages: ['tag'], requestId: expect.any(String) }))
  first.unmount()
  const restored = renderHook(usePipelineQueue, { wrapper })
  act(() => restored.result.current.select('saved-run'))
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

test('local controls combine desktop stages and permit Queue while Start is busy', async () => {
  const enqueue = vi.fn().mockResolvedValue(saved())
  render(<PipelineRunControls underTagged={[plate]} batchPlates={[]} allPlates={[plate]} stateName="Alaska" queue={{ runs: [saved({ status: 'running' })], action: null, message: '', disabledReason: undefined, enqueue }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Colors' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Only under-tagged plates' }))
  expect((screen.getByRole('button', { name: 'Start run' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Queue run' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByLabelText(/Preview only/))
  fireEvent.click(screen.getByRole('button', { name: 'Queue run' }))
  await waitFor(() => expect(enqueue).toHaveBeenCalledWith([plate], ['colors', 'tag'], 'desktop-gemma4-12b', { tag: { onlyUnderTagged: true } }, true, 'desktop-gemma4-12b', undefined, 'Alaska pipeline'))
})

test('Gateway Tag remains selectable alongside Desktop Colors in the durable Run pipeline', async () => {
  mocks.modelId = 'gateway-gemma4-26b'
  const enqueue = vi.fn().mockResolvedValue(saved())
  render(<PipelineRunControls underTagged={[plate]} batchPlates={[plate]} stateName="Alaska" queue={{ runs: [], action: null, message: '', disabledReason: undefined, enqueue }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Colors' }))
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  await waitFor(() => expect(enqueue).toHaveBeenCalledWith([plate], ['colors', 'tag'], 'desktop-gemma4-12b', { tag: { onlyUnderTagged: false } }, false, 'gateway-gemma4-26b', undefined, 'Alaska pipeline'))
})

test('the combined Research control enqueues its selected hosted model and policy once', async () => {
  const plates = [plate, { ...plate, id: 'AK.two' }]
  mocks.api.get.mockImplementation(async path => path === '/api/research/models'
    ? { models: RESEARCH_MODELS, default: RESEARCH_MODELS[0].id } : { runs: [] })
  function Controls() {
    const queue = usePipelineQueue()
    return <PipelineRunControls underTagged={plates} batchPlates={plates} stateName="Alaska" queue={queue} />
  }
  render(<Controls />, { wrapper })
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Tag' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Research / enrich' }))
  for (const name of ['Wiki link', 'Describe', 'Story']) expect(screen.queryByRole('checkbox', { name })).toBeNull()
  const policy = screen.getByRole('combobox', { name: 'Research edits' }) as HTMLSelectElement
  expect(policy.value).toBe('fill-missing')
  const picker = await screen.findByRole('combobox', { name: 'Research model' })
  expect(picker.textContent).toContain('On-device worker (Ollama)')
  fireEvent.keyDown(picker, { key: 'ArrowDown' })
  const hosted = await screen.findByRole('option', { name: /Hosted research \(Eve\).*Gemini/ })
  fireEvent.click(hosted)
  expect(screen.getByRole('dialog', { name: 'Run pipeline' })).toBeTruthy()
  expect(screen.getByText(/Research will use Hosted research \(Eve\).*Gemini/)).toBeTruthy()
  fireEvent.change(policy, { target: { value: 'replace' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  await waitFor(() => expect(mocks.api.send).toHaveBeenCalledExactlyOnceWith('POST', '/api/local-pipeline/runs/selection', {
    requestId: expect.any(String), batchName: 'Alaska pipeline', plateIds: ['AK.one', 'AK.two'], stages: ['research'],
    options: { research: { policy: 'replace' } }, previewOnly: false, researchModelId: RESEARCH_MODELS[2].id,
  }))
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

test('research model discovery distinguishes loading, failure, empty, and desktop-only catalogs', async () => {
  localStorage.setItem('research-model:v1', RESEARCH_MODELS[2].id)
  let failDiscovery!: (error: Error) => void
  mocks.api.get.mockImplementationOnce(() => new Promise((_, reject) => { failDiscovery = reject }))
    .mockResolvedValueOnce({ models: [], default: RESEARCH_MODELS[2].id })
  const enqueue = vi.fn().mockResolvedValue(saved())
  const controls = <PipelineRunControls underTagged={[plate]} batchPlates={[plate]} stateName="Alaska" queue={{ runs: [], action: null, message: '', disabledReason: undefined, enqueue }} />
  const initial = render(controls, { wrapper })
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Tag' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Research / enrich' }))
  expect(screen.getByRole('status').textContent).toBe('Loading research models…')
  expect((screen.getByRole('button', { name: 'Start run' }) as HTMLButtonElement).disabled).toBe(true)
  failDiscovery(new Error('Offline'))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('No research models are available.')
  expect((screen.getByRole('button', { name: 'Queue run' }) as HTMLButtonElement).disabled).toBe(true)
  expect(enqueue).not.toHaveBeenCalled()
  initial.unmount()

  mocks.api.get.mockResolvedValueOnce({ models: RESEARCH_MODELS.slice(0, 2), default: RESEARCH_MODELS[2].id })
  render(controls, { wrapper })
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Tag' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Research / enrich' }))
  fireEvent.keyDown(await screen.findByRole('combobox', { name: 'Research model' }), { key: 'ArrowDown' })
  expect(screen.getAllByRole('option')).toHaveLength(2)
  expect(screen.queryByRole('option', { name: /Hosted research/ })).toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.getByRole('dialog', { name: 'Run pipeline' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  await waitFor(() => expect(enqueue).toHaveBeenCalledWith([plate], ['research'], undefined, { research: { policy: 'fill-missing' } }, false, undefined, RESEARCH_MODELS[0].id, 'Alaska pipeline'))
})

test('Fill missing explains why a complete Batch selection has no research to run', async () => {
  const complete = { ...plate, description: 'Existing description', wikiUrl: 'https://example.org/wiki', firstIssuedYear: 1976,
    funFacts: [{ text: 'Existing fact', sourceUrl: 'https://example.org/fact' }],
    readMore: [{ site: 'Museum', title: 'Existing source', url: 'https://example.org/history' }] }
  const enqueue = vi.fn()
  mocks.api.get.mockResolvedValue({ models: RESEARCH_MODELS, default: RESEARCH_MODELS[0].id })
  render(<PipelineRunControls underTagged={[plate]} batchPlates={[complete]} stateName="Alaska" queue={{ runs: [], action: null, message: '', disabledReason: undefined, enqueue }} />, { wrapper })
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('button', { name: 'Plates in your batch 1' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Tag' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Research / enrich' }))
  expect(screen.getByText(/The selected plates already have research fields/)).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Start run' }).disabled).toBe(true)
  fireEvent.change(screen.getByRole('combobox', { name: 'Research edits' }), { target: { value: 'replace' } })
  await screen.findByRole('combobox', { name: 'Research model' })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Start run' }).disabled).toBe(false)
})

test('worker capabilities enable Group and normalize unsupported default colour signal OFF; Preview ignores standalone capability', async () => {
  const enqueue = vi.fn().mockResolvedValue(saved())
  const capabilities = { ...imageGroupCapabilities({ embeddings: true, backgroundMask: false, visionTiebreak: false, maskReason: 'Mask unavailable' }), reportedAt: 100, pollIntervalMs: 1000 }
  render(<PipelineRunControls underTagged={[plate]} batchPlates={[plate]} stateName="Alaska" queue={{ runs: [], action: null, message: '', disabledReason: undefined, enqueue, capabilities }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Group' }))
  expect(screen.getByText('Method · Embeddings')).toBeTruthy()
  expect(screen.queryByRole('combobox', { name: 'Method' })).toBeNull()
  const colour = screen.getByLabelText(/Use colour signal/) as HTMLInputElement
  expect(colour.checked).toBe(false)
  expect(colour.disabled).toBe(true)
  expect((screen.getByLabelText(/Preview only/) as HTMLInputElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  await waitFor(() => expect(enqueue).toHaveBeenCalledWith([plate], ['tag', 'group'], 'desktop-gemma4-12b', {
    tag: { onlyUnderTagged: false }, group: { method: 'embeddings', colorSignal: false, backgroundMask: false, visionTiebreak: false },
  }, false, 'desktop-gemma4-12b', undefined, 'Alaska pipeline'))
})

test('Group explains an unavailable method and cannot queue after the worker loses it', () => {
  const enqueue = vi.fn()
  const capabilities = { ...imageGroupCapabilities({ embeddings: true, backgroundMask: true, visionTiebreak: true }), reportedAt: 100, pollIntervalMs: 1000 }
  const queue = { runs: [], action: null, message: '', disabledReason: undefined, enqueue, capabilities }
  const view = (capabilities: typeof queue.capabilities) => <PipelineRunControls underTagged={[plate]} batchPlates={[plate]} stateName="Alaska" queue={{ ...queue, capabilities }} />
  const result = render(view(capabilities))
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Group' }))

  result.rerender(view({ ...capabilities, embeddings: { available: false, reason: 'Embedding model offline' } }))
  expect(screen.getByText('Method · Embedding model offline')).toBeTruthy()
  expect(screen.queryByRole('combobox', { name: 'Method' })).toBeNull()
  const group = screen.getByRole<HTMLInputElement>('checkbox', { name: /Group: Embedding model offline/ })
  expect(group.checked).toBe(true)
  const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Start run' })
  expect(start.disabled).toBe(true)
  fireEvent.click(start)
  expect(enqueue).not.toHaveBeenCalled()
  fireEvent.click(group)
  expect(group.disabled).toBe(true)
  expect(start.disabled).toBe(false)
})

test('a method control with multiple available choices exposes a selector', () => {
  const choices = [{ value: 'fixture-one', label: 'Fixture one' }, { value: 'fixture-two', label: 'Fixture two' }]
  const onChange = vi.fn()
  render(<PipelineOptionSelect label="Method" choices={choices} value={choices[0].value} onChange={onChange} disabled={false} />)
  const method = screen.getByRole('combobox', { name: 'Method' })
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Fixture one', 'Fixture two'])
  fireEvent.change(method, { target: { value: choices[1].value } })
  expect(onChange).toHaveBeenCalledWith(choices[1].value)
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
  expect(mocks.api.send).toHaveBeenCalledWith('POST', '/api/local-pipeline/runs/selection', expect.objectContaining({ batchId: 'existing-batch', previewOnly: true }))
})

test('run cards describe cancelled dependencies and share the real workflow link after deliberate hover', async () => {
  const run = saved({ status: 'failed', stages: ['wiki-link', 'describe', 'story'] })
  run.attempts[0] = { ...run.attempts[0], status: 'failed', endedAt: 33100, workflowId: 'wrun_real', workflowUrl: 'https://vercel.com/memoriuhl/plate-curator-vercel/workflows/runs/wrun_real?environment=preview', steps: [
    { index: 0, plateId: 'AK.one', stage: 'wiki-link', resourceClass: 'io', status: 'failed', startedAt: 100, endedAt: 33100, reason: 'no_sources' },
    { index: 1, plateId: 'AK.one', stage: 'describe', resourceClass: 'gpu', status: 'cancelled', reason: 'upstream_failed' },
    { index: 2, plateId: 'AK.one', stage: 'story', resourceClass: 'gpu', status: 'cancelled', reason: 'upstream_failed' },
  ] }
  render(<TooltipProvider><PipelineRunCard run={run} stages={run.stages} progress={queueProgress(run)} observedAt={99999} requester="Editor" /></TooltipProvider>)
  expect(screen.getByRole('button', { name: /Wiki link: Failed · 00:33/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Describe: Cancelled · not run/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Story: Cancelled · not run/ })).toBeTruthy()
  expect(screen.queryByRole('progressbar')).toBeNull()
  act(() => screen.getByRole('button', { name: /Describe: Cancelled/ }).focus())
  expect((await screen.findByRole('tooltip')).textContent).toContain('An earlier step failed. This step did not run.')
  const stack = screen.getByRole('button', { name: '1 plate in run aved-run' })
  act(() => stack.focus())
  fireEvent.click(stack)
  expect(screen.queryByRole('dialog')).toBeNull()
  vi.useFakeTimers()
  try {
    fireEvent.pointerEnter(stack, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(999))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    const link = screen.getByRole('link', { name: 'Watch this workflow' })
    expect(link.getAttribute('href')).toBe(run.attempts[0].workflowUrl)
    expect(link.getAttribute('target')).toBe('_blank')
  } finally {
    vi.useRealTimers()
  }
})

test('execution dropdown switches local and gateway views without mutating or restarting runs', async () => {
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
  await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'Local PC' })).toBeTruthy())
  expect(screen.queryByText('Studio PC')).toBeNull()
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Vercel Gateway/ }))
  await waitFor(() => expect(screen.getByRole('article', { name: 'Pipeline run gateway-run' })).toBeTruthy())
  expect(screen.queryByRole('article', { name: 'Pipeline run saved-run' })).toBeNull()
  expect(screen.getByRole('button', { name: /^View runs: Vercel Gateway$/ })).toBeTruthy()
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

test('incremental History links to saved changes and preserves visibility of a conflicting stage', () => {
  const run = saved({ id: 'run-chunk', batchId: 'pipeline-draft', batchName: 'Coastal Batch', status: 'failed', incrementalDrafts: true, previewOnly: false, draftPlateIds: ['AK.one'] })
  run.attempts[0].steps[0] = { ...run.attempts[0].steps[0], status: 'failed', reason: 'draft_conflict' }
  const controls = { runs: [run], selected: run, select: vi.fn(), loading: false, error: null, refresh: vi.fn(), action: null, message: '', cancel: vi.fn(), retry: vi.fn(), apply: vi.fn(), chooseImage: vi.fn(), recover: vi.fn() }
  render(<PipelineQueuePanel queue={controls} />)
  expect(screen.getByText(/1 Plate saved to Coastal Batch/)).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('Your edits were kept')
  expect(screen.queryByRole('button', { name: 'Apply coherent run to your Batch' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'History' }))
  expect(screen.getByRole('link', { name: 'Run un-chunk' }).getAttribute('href')).toBe('/review?batch=pipeline-draft&run=run-chunk')
  expect(screen.getByRole('link', { name: 'Review run changes' }).getAttribute('href')).toBe('/review?batch=pipeline-draft&run=run-chunk')
})

test('full-state runs keep the whole selection and explain the per-state Group limit before enqueue', async () => {
  const enqueue = vi.fn().mockResolvedValue(saved())
  const plates = Array.from({ length: 990 }, (_, index) => ({ ...plate, id: `MD.${index}`, state: 'MD' }))
  const capabilities = { ...imageGroupCapabilities({ embeddings: true, backgroundMask: false, visionTiebreak: false }), reportedAt: 100, pollIntervalMs: 1000 }
  render(<PipelineRunControls underTagged={[]} batchPlates={[]} allPlates={plates} stateName="Maryland" queue={{ runs: [], action: null, message: '', disabledReason: undefined, enqueue, capabilities }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('button', { name: 'All plates in Maryland 990' }))
  expect(screen.getByText('New draft · Maryland pipeline')).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Group' }))
  expect(screen.getByRole('alert').textContent).toContain('Group needs up to 25 plates from one state')
  expect((screen.getByRole('button', { name: 'Start run' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Group' }))
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  await waitFor(() => expect(enqueue.mock.calls[0]?.[0]).toEqual(plates))
})
