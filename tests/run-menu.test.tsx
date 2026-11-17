// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { plateSelection } from '../components/dashboard/plate-selection'
import { plateCards } from '../fixtures/plate-cards'
import { RunMenu } from '../components/dashboard/run-menu'
import { TagRunBanner } from '../components/dashboard/tag-run-banner'
import {
  useTagRun,
  type RunEntry,
  type RunPlate,
} from '../components/dashboard/use-tag-run'
import { PlateTagActions } from '../components/dashboard/plate-tag-actions'
import { TAGGING_MODELS } from '../lib/tagging/models'
import { formatTaggingModel } from '../lib/client/tagging-models'
import { ApiError } from '../lib/client/api'
import { SpecializedSuggestion } from '../components/dashboard/specialized-suggestion'
import type { ImageSuggestion } from '../lib/jobs/specialized-suggestions'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn().mockResolvedValue(undefined),
  models: { data: undefined } as { data: { models: typeof TAGGING_MODELS[number][]; default: string } | undefined },
  api: { get: vi.fn(), send: vi.fn() },
  ensure: vi.fn(),
  edit: vi.fn(),
  workspace: { mode: 'personal' } as { mode: 'personal' } | { mode: 'selected'; id: string; status: string; detail?: { batch: { state: string } } },
  detail: { plates: [] as { proposed: RunPlate }[] },
}))
vi.mock('swr', async importOriginal => ({ ...await importOriginal<typeof import('swr')>(), useSWRConfig: () => ({ mutate: mocks.mutate }) }))
vi.mock('../lib/client/session', () => ({
  useSession: () => ({ api: mocks.api }),
}))
vi.mock('../lib/client/hooks', () => ({
  useTaggingModels: () => mocks.models,
  useEnsureBatch: () => mocks.ensure,
  useWorkspaceBatch: () => mocks.workspace,
  useBatch: () => ({ data: mocks.detail }),
  useEditPlate: () => ({ edit: mocks.edit, pending: false }),
}))

const plate: RunPlate = {
  id: 'MD.one',
  state: 'MD',
  displayName: 'Maryland one',
  revision: 'r1',
  tags: ['Blue'],
}
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  mocks.mutate.mockClear()
  localStorage.clear()
  mocks.models.data = { models: [...TAGGING_MODELS], default: 'desktop-gemma4-12b' }
  mocks.workspace = { mode: 'personal' }
  mocks.ensure.mockReset().mockResolvedValue('batch')
  mocks.api.send.mockReset().mockImplementation(async (_method, path) => ({
    jobId: path.split('/')[5],
    runId: 'run',
  }))
  mocks.api.get
    .mockReset()
    .mockResolvedValue({ state: 'queued', suggestions: [] })
  mocks.edit.mockReset().mockImplementation(async (_plate, fields) => ({
    ok: true,
    proposed: { ...plate, ...fields },
  }))
  mocks.detail.plates = []
})
afterEach(() => {
  vi.unstubAllEnvs()
  plateSelection.clear()
  cleanup()
  vi.useRealTimers()
})

test('scope counts, default scope, cap, disabled stages, and focus return', async () => {
  const start = vi.fn()
  const plates = Array.from({ length: 30 }, (_, i) => ({
    ...plate,
    id: `MD.${i}`,
  }))
  render(
    <RunMenu
      underTagged={plates}
      batchPlates={[]}
      stateName="Maryland"
      disabled={false}
      start={start}
    />,
  )
  const trigger = screen.getByRole('button', { name: 'Run pipeline' })
  fireEvent.click(trigger)
  expect(
    screen
      .getByRole('button', { name: 'Plates in your batch 0' })
      .hasAttribute('disabled'),
  ).toBe(true)
  expect(
    screen
      .getByRole('button', { name: 'Under-tagged plates 30' })
      .getAttribute('aria-pressed'),
  ).toBe('true')
  expect(screen.getByText('First 25 of 30')).toBeTruthy()
  for (const stage of [
    'Find image',
    'Wiki link',
    'Colors',
    'Describe',
    'Story',
    'Group',
    'Order',
  ]) {
    expect(
      screen
        .getByRole('checkbox', { name: `${stage}: Coming soon` })
        .closest('fieldset')?.disabled,
    ).toBe(true)
  }
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await act(async () => {})
  expect(screen.queryByText('First 25 of 30')).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  expect(start).toHaveBeenCalledWith(plates.slice(0, 25), false, 'desktop-gemma4-12b')
})

test('batch scope uses its own count and plates', () => {
  const start = vi.fn()
  render(
    <RunMenu
      underTagged={[]}
      batchPlates={[plate]}
      stateName="Maryland"
      disabled={false}
      start={start}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(
    screen.getByRole('button', { name: 'Plates in your batch 1' }),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  expect(start).toHaveBeenCalledWith([plate], false, 'desktop-gemma4-12b')
})

test('start ensures once, posts each plate, and treats initial 404 as queued then errors after ten seconds', async () => {
  vi.useFakeTimers()
  mocks.api.get.mockRejectedValue(new ApiError(404, 'not_found', {}))
  const { result } = renderHook(useTagRun)
  await act(async () => {
    await result.current.start([plate, { ...plate, id: 'MD.two' }])
  })
  expect(mocks.ensure).toHaveBeenCalledTimes(1)
  expect(mocks.api.send).toHaveBeenCalledTimes(2)
  expect(mocks.api.send).toHaveBeenCalledWith(
    'POST',
    '/api/batches/batch/plates/MD.one/tagging',
    {},
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000)
  })
  expect(
    result.current.entries.every(
      (entry) => !entry.error && entry.job.state === 'queued',
    ),
  ).toBe(true)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(result.current.entries.every((entry) => !!entry.error)).toBe(true)
})

test('polls claimed then completed and stops after dismissal or unmount', async () => {
  vi.useFakeTimers()
  mocks.api.get
    .mockResolvedValueOnce({ state: 'claimed', suggestions: [] })
    .mockResolvedValueOnce({ state: 'completed', suggestions: ['bird'] })
  const { result, unmount } = renderHook(useTagRun)
  await act(async () => {
    await result.current.start([plate])
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(result.current.entries[0].job.state).toBe('claimed')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(result.current.entries[0].job.state).toBe('completed')
  act(() => result.current.dismiss())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000)
  })
  expect(mocks.api.get).toHaveBeenCalledTimes(2)
  unmount()
})

test('per plate request failures expose reasons and expired retry reuses ensure', async () => {
  mocks.api.send
    .mockRejectedValueOnce(new ApiError(403, 'forbidden', {}))
    .mockRejectedValueOnce(new ApiError(422, 'invalid_state', {}))
    .mockRejectedValueOnce(new ApiError(404, 'not_found', {}))
  const { result } = renderHook(useTagRun)
  await act(async () => {
    await result.current.start([
      plate,
      { ...plate, id: 'two' },
      { ...plate, id: 'three' },
    ])
  })
  expect(result.current.entries.map((entry) => entry.error)).toEqual([
    "Only the batch's creator or an Owner can edit it.",
    'This batch is no longer open for editing.',
    'This plate or batch could not be found.',
  ])
})

test('expired jobs can retry and active polling stops on unmount', async () => {
  vi.useFakeTimers()
  mocks.api.get.mockResolvedValue({ state: 'expired', suggestions: [] })
  const { result, unmount } = renderHook(useTagRun)
  await act(async () => {
    await result.current.start([plate])
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(result.current.entries[0].job.state).toBe('expired')
  await act(async () => {
    await result.current.start([plate], true)
  })
  expect(mocks.ensure).toHaveBeenCalledTimes(2)
  expect(result.current.entries[0].job.state).toBe('queued')
  unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000)
  })
  expect(mocks.api.get).toHaveBeenCalledTimes(1)
})

test('banner counts and accept merges overlay tags, normalizes and deduplicates with one edit', async () => {
  mocks.detail.plates = [{ proposed: { ...plate, tags: ['Blue', 'earlier'] } }]
  const entries: RunEntry[] = ['queued', 'claimed', 'completed', 'expired'].map(
    (state, i) => ({
      plate: { ...plate, id: i === 2 ? plate.id : `MD.${i}` },
      job: {
        state: state as RunEntry['job']['state'],
        suggestions: ['BLUE', ' BIRD ', 'bird'],
      },
    }),
  )
  render(
    <TagRunBanner
      entries={entries}
      batchId="batch"
      starting={false}
      dismiss={vi.fn()}
      retry={vi.fn()}
    />,
  )
  expect(screen.getByRole('status').textContent).toContain(
    'Tagging 4 plates · 1 queued · 1 claimed · 1 done · 1 expired',
  )
  expect(screen.getByText('Timed out; try again')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Accept all' }))
  await act(async () => {})
  expect(mocks.edit).toHaveBeenCalledTimes(1)
  expect(mocks.edit).toHaveBeenCalledWith(plate, {
    tags: ['blue', 'earlier', 'bird'],
  }, { batchId: 'batch', baseRevision: 'r1' })
})

test.each(['loading', 'unavailable', 'read-only'])('selected %s Batch cannot start Tag or accept a suggestion', async status => {
  mocks.workspace = { mode: 'selected', id: 'shared', status }
  const { result } = renderHook(useTagRun)
  await act(async () => { await result.current.start([plate]) })
  expect(result.current.disabledReason).toBeTruthy()
  expect(mocks.ensure).not.toHaveBeenCalled()
  expect(mocks.api.send).not.toHaveBeenCalled()
  render(<TagRunBanner batchId="shared" entries={[{ plate, job: { state: 'completed', suggestions: ['bird'], inputHash: 'reviewed' } }]} starting={false} dismiss={vi.fn()} retry={vi.fn()} />)
  const accept = screen.getByRole('button', { name: 'Accept bird for Maryland one' })
  expect(accept.hasAttribute('disabled')).toBe(true)
  fireEvent.click(accept)
  expect(mocks.edit).not.toHaveBeenCalled()
})

test('a chosen model is sent with each Tag request and reused on retry', async () => {
  vi.useFakeTimers()
  mocks.workspace = { mode: 'selected', id: 'shared', status: 'ready', detail: { batch: { state: 'open' } } }
  mocks.api.get.mockResolvedValue({ state: 'expired', suggestions: [], inputHash: 'reviewed' })
  const { result } = renderHook(useTagRun)
  await act(async () => { await result.current.start([plate], false, 'gateway-gemma4-26b') })
  expect(mocks.api.send).toHaveBeenLastCalledWith('POST', '/api/batches/shared/plates/MD.one/tagging', { model: 'gateway-gemma4-26b' })
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  await act(async () => { await result.current.start([plate], true) })
  expect(mocks.api.send).toHaveBeenLastCalledWith('POST', '/api/batches/shared/plates/MD.one/tagging', { model: 'gateway-gemma4-26b' })
  vi.useRealTimers()
})

test('selected run uses its Batch and keeps polling, retry and dismiss behavior', async () => {
  vi.useFakeTimers()
  mocks.workspace = { mode: 'selected', id: 'shared', status: 'ready', detail: { batch: { state: 'open' } } }
  mocks.api.get.mockResolvedValue({ state: 'expired', suggestions: [], inputHash: 'reviewed' })
  const { result } = renderHook(useTagRun)
  await act(async () => { await result.current.start([plate]) })
  expect(mocks.api.send).toHaveBeenCalledWith('POST', '/api/batches/shared/plates/MD.one/tagging', {})
  expect(mocks.ensure).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(result.current.entries[0].job.state).toBe('expired')
  await act(async () => { await result.current.start([plate], true) })
  expect(result.current.entries[0].job.state).toBe('queued')
  expect(mocks.api.send).toHaveBeenCalledTimes(2)
  act(() => result.current.dismiss())
  await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
  expect(result.current.entries).toEqual([])
  expect(mocks.api.get).toHaveBeenCalledTimes(1)
})

test('switching workspace clears proposals and ignores an in-flight start response', async () => {
  mocks.workspace = { mode: 'selected', id: 'shared', status: 'ready', detail: { batch: { state: 'open' } } }
  let finish!: (value: { jobId: string; runId: string }) => void
  mocks.api.send.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { result, rerender } = renderHook(useTagRun)
  let start!: Promise<void>
  act(() => { start = result.current.start([plate]) })
  await act(async () => {})
  mocks.workspace = { mode: 'personal' }
  rerender()
  await act(async () => { finish({ jobId: 'old', runId: 'old' }); await start })
  expect(result.current.entries).toEqual([])
  expect(result.current.batchId).toBeNull()
})


test('formats measured labels', () => {
  expect(formatTaggingModel(TAGGING_MODELS[2])).toBe('Gemma 4 26B \u00b7 $0.0003/plate')
  expect(formatTaggingModel(TAGGING_MODELS[0])).toBe('Gemma 4 12B \u00b7 free, local GPU')
})
test.each([undefined, 'gateway-gemma4-26b', 'stale'])('Plate restores choice %s and sends selected model', async stored => {
  if (stored) localStorage.setItem('tagging-model:v1', stored)
  render(<PlateTagActions plate={plate} />)
  expect(screen.getByRole('combobox').textContent).toContain(stored === 'gateway-gemma4-26b' ? '$0.0003/plate' : '12B')
  fireEvent.click(screen.getByRole('combobox'))
  fireEvent.click(screen.getByRole('option', { name: /Gemma 4 26B.*0\.0003/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Run Tag' }))
  await waitFor(() => expect(mocks.api.send).toHaveBeenCalledWith('POST', '/api/batches/batch/plates/MD.one/tagging', { model: 'gateway-gemma4-26b' }))
  expect(localStorage.getItem('tagging-model:v1')).toBe('gateway-gemma4-26b')
})
test.each([true, false])('hides single or loading picker %s', single => {
  mocks.models.data = single ? { models: [TAGGING_MODELS[0]], default: TAGGING_MODELS[0].id } : undefined
  render(<PlateTagActions plate={plate} />)
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.getByRole('button', { name: 'Run Tag' }).hasAttribute('disabled')).toBe(false)
})
test('storage failures allow rendering and selection', () => {
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('blocked') })
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('blocked') })
  try {
    render(<PlateTagActions plate={plate} />)
    fireEvent.click(screen.getByRole('combobox'))
  fireEvent.click(screen.getByRole('option', { name: /Gemma 4 26B.*0\.0003/ }))
    expect(screen.getByRole('combobox').textContent).toContain('$0.0003/plate')
  } finally { read.mockRestore(); write.mockRestore() }
})
test('disabled model error appears inline on Plate page', async () => {
  mocks.api.send.mockRejectedValue(new ApiError(422, 'invalid_state', {}))
  render(<PlateTagActions plate={plate} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run Tag' }))
  await waitFor(() => expect(screen.getByText('That model is no longer available. Choose another.')).toBeTruthy())
  expect(mocks.mutate).toHaveBeenCalledWith('/api/tagging/models')
})

test('Run menu passes chosen model and shows availability error beside picker', () => {
  const start = vi.fn()
  render(<RunMenu underTagged={[plate]} batchPlates={[]} stateName="Maryland" disabled={false} start={start} modelError="That model is no longer available. Choose another." />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  expect(screen.getByRole('alert').textContent).toBe('That model is no longer available. Choose another.')
  fireEvent.click(screen.getByRole('combobox'))
  fireEvent.click(screen.getByRole('option', { name: /Gemma 4 26B.*0\.0003/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  expect(start).toHaveBeenCalledWith([plate], false, 'gateway-gemma4-26b')
})
test('Run menu hides picker with one model', () => {
  mocks.models.data = { models: [TAGGING_MODELS[0]], default: TAGGING_MODELS[0].id }
  render(<RunMenu underTagged={[plate]} batchPlates={[]} stateName="Maryland" disabled={false} start={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  expect(screen.queryByRole('combobox')).toBeNull()
})

test('selection scope passes plates across states to the pipeline', () => {
  const selected = [{ ...plateCards[0], id: 'NY.a', state: 'NY' }, { ...plateCards[0], id: 'NJ.b', state: 'NJ' }]
  plateSelection.add(selected)
  const start = vi.fn()
  render(<RunMenu underTagged={[]} batchPlates={[]} stateName="New York" disabled={false} start={start} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  expect(screen.getByRole('button', { name: 'Selected plates 2' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  expect(start).toHaveBeenCalledWith(selected, false, 'desktop-gemma4-12b')
})

test('local state scope, under-tagged predicate and limit use loaded plates', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const start = vi.fn()
  const all = [{ ...plate, tags: ['blue', 'bird', 'tree'] }, { ...plate, id: 'MD.two' }, { ...plate, id: 'MD.three' }]
  render(<RunMenu underTagged={[all[1], all[2]]} allPlates={all} batchPlates={[]} stateName="Maryland" disabled={false} start={start} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('button', { name: 'All of Maryland 3' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Only under-tagged plates' }))
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Limit' }), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  expect(start).toHaveBeenCalledWith([all[1]], false, 'desktop-gemma4-12b')
})

test('deployed menu does not enable local scope or limit', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  render(<RunMenu underTagged={[plate]} allPlates={[plate]} batchPlates={[]} stateName="Maryland" disabled={false} start={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  expect(screen.getByRole('button', { name: 'All of Maryland: Coming soon' }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('spinbutton', { name: 'Limit' })).toBeNull()
})

test('local limit rejects blank and out-of-range values without starting a run', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const start = vi.fn()
  render(<RunMenu underTagged={[plate]} allPlates={[plate]} batchPlates={[]} stateName="Maryland" disabled={false} start={start} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  for (const value of ['', '0', '26', '1.5']) {
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Limit' }), { target: { value } })
    expect(screen.getByRole('button', { name: 'Start run' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  }
  expect(start).not.toHaveBeenCalled()
  expect(screen.getByText('Enter a whole number from 1 to 25.')).toBeTruthy()
})

test('local unsupported stages name the missing integration', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  render(<RunMenu underTagged={[plate]} batchPlates={[]} stateName="Maryland" disabled={false} start={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  expect(screen.getByRole('checkbox', { name: 'Wiki link: Needs a reference-search job and draft result' }).closest('fieldset')?.disabled).toBe(true)
  expect(screen.queryByText('Coming soon')).toBeNull()
})

test('a sourced field suggestion uses the reviewed input hash and the existing Batch edit flow', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const fields = { description: 'Sourced description' }
  mocks.detail.plates = [{ proposed: Object.assign({}, plate, { description: 'Current description' }) }]
  render(<TagRunBanner entries={[{ plate, jobId: 'field-job', job: { state: 'completed', suggestions: [], inputHash: 'reviewed-input', stage: 'describe', fieldSuggestion: { kind: 'fields' as const, stage: 'describe', fields, sources: ['https://example.org/source'] } } }]} batchId="batch" starting={false} dismiss={vi.fn()} retry={vi.fn()} />)
  expect(screen.getByText('Current description')).toBeTruthy()
  expect(screen.getByText('Sourced description')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'https://example.org/source' }).getAttribute('href')).toBe('https://example.org/source')
  fireEvent.click(screen.getByRole('button', { name: 'Accept describe suggestion' }))
  await waitFor(() => expect(mocks.edit).toHaveBeenCalledWith(plate, fields, { batchId: 'batch', baseRevision: 'reviewed-input' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Saved to your Batch' }).hasAttribute('disabled')).toBe(true))
})

test('completed no-result jobs are counted separately from successful results', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  render(<TagRunBanner entries={[
    { plate, job: { state: 'completed', suggestions: [], stage: 'story', stageError: 'no_supported_fields' } },
    { plate: { ...plate, id: 'MD.two' }, job: { state: 'completed', suggestions: ['wildlife'] } },
  ]} batchId="batch" starting={false} dismiss={vi.fn()} retry={vi.fn()} />)
  expect(screen.getByRole('status').textContent).toContain('1 done')
  expect(screen.getByRole('status').textContent).toContain('1 no result')
})

test('a stale field suggestion shows the conflict without claiming acceptance', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  mocks.edit.mockResolvedValueOnce({ ok: false, error: 'stale_plate' })
  render(<TagRunBanner entries={[{ plate, job: { state: 'completed', suggestions: [], inputHash: 'reviewed-input', stage: 'describe', fieldSuggestion: { kind: 'fields' as const, stage: 'describe', fields: { description: 'Sourced description' }, sources: ['https://example.org/source'] } } }]} batchId="batch" starting={false} dismiss={vi.fn()} retry={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Accept describe suggestion' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Someone changed this while you were editing.'))
  expect(screen.queryByRole('button', { name: 'Saved to your Batch' })).toBeNull()
})

test.each([false, true])('field acceptance requires the local gate and a reviewed hash: %s', local => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', local ? '1' : '0')
  render(<TagRunBanner entries={[{ plate, job: { state: 'completed', suggestions: [], stage: 'describe', fieldSuggestion: { kind: 'fields' as const, stage: 'describe', fields: { description: 'Sourced description' }, sources: ['https://example.org/source'] } } }]} batchId="batch" starting={false} dismiss={vi.fn()} retry={vi.fn()} />)
  const button = screen.queryByRole('button', { name: 'Accept describe suggestion' })
  if (local) expect(button?.hasAttribute('disabled')).toBe(true)
  else expect(button).toBeNull()
  expect(mocks.edit).not.toHaveBeenCalled()
})

test('local Describe runs use the shared local model picker and typed stage request', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const start = vi.fn()
  render(<RunMenu underTagged={[plate]} batchPlates={[]} stateName="Maryland" disabled={false} start={start} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Describe' }))
  expect((screen.getByRole('checkbox', { name: 'Tag' }) as HTMLInputElement).checked).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  expect(start).toHaveBeenCalledWith([plate], false, 'desktop-gemma4-12b', 'describe')
})

test('Story skips existing stories until Redo is enabled', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const start = vi.fn()
  const existing = { ...plate, hasStory: true }
  render(<RunMenu underTagged={[existing]} batchPlates={[]} stateName="Maryland" disabled={false} start={start} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Story' }))
  expect(screen.getByRole('button', { name: 'Start run' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Redo plates that already have a story' }))
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  expect(start).toHaveBeenCalledWith([existing], false, 'desktop-gemma4-12b', 'story')
})

test('stage retries retain both the selected model and stage', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const { result } = renderHook(useTagRun)
  await act(async () => { await result.current.start([plate], false, 'desktop-gemma4-12b', 'story') })
  expect(mocks.api.send).toHaveBeenLastCalledWith('POST', '/api/batches/batch/plates/MD.one/pipeline', { model: 'desktop-gemma4-12b', stage: 'story' })
  await act(async () => { await result.current.start([plate], true) })
  expect(mocks.api.send).toHaveBeenLastCalledWith('POST', '/api/batches/batch/plates/MD.one/pipeline', { model: 'desktop-gemma4-12b', stage: 'story' })
})

test('image candidate choice is explicit and projection-only until aggregate Apply', async () => {
  const suggestion: ImageSuggestion = { kind: 'image', stage: 'find-image', sources: [], candidates: [{ id: 'photo', title: 'Alaska plate', imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Plate.jpg', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Plate.jpg', width: 640, height: 320, sha256: 'a'.repeat(64), license: 'CC BY 4.0' }] }
  const choose = vi.fn().mockResolvedValue(undefined)
  render(<SpecializedSuggestion suggestion={suggestion} plates={[]} blocked={false} accepted={false} onSelectImage={choose} />)
  const useImage = screen.getByRole('button', { name: 'Use selected image for this run' }) as HTMLButtonElement
  expect(useImage.disabled).toBe(true)
  expect(screen.getByRole('img', { name: 'Alaska plate' })).toBeTruthy()
  expect(screen.getByRole('link', { name: /Image provenance/ }).getAttribute('href')).toBe(suggestion.candidates[0].sourceUrl)
  expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: 'Alaska plate' }))
  fireEvent.click(useImage)
  await waitFor(() => expect(choose).toHaveBeenCalledWith('photo'))
  expect(mocks.edit).not.toHaveBeenCalled()
})

test('image chooser instances have independent radio groups', () => {
  const candidates: ImageSuggestion = { kind: 'image', stage: 'find-image', sources: [], candidates: [{ id: 'photo', title: 'Plate photo', imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Plate.jpg', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Plate.jpg', width: 640, height: 320, sha256: 'a'.repeat(64) }] }
  render(<><SpecializedSuggestion suggestion={candidates} plates={[]} blocked={false} accepted={false} onSelectImage={vi.fn()} /><SpecializedSuggestion suggestion={candidates} plates={[]} blocked={false} accepted={false} onSelectImage={vi.fn()} /></>)
  const radios = screen.getAllByRole('radio') as HTMLInputElement[]
  fireEvent.click(radios[0])
  fireEvent.click(radios[1])
  expect(radios.every(radio => radio.checked)).toBe(true)
  expect(radios[0].name).not.toBe(radios[1].name)
})

test('a restored durable image choice can resume without changing the checked radio', async () => {
  const candidates: ImageSuggestion = { kind: 'image', stage: 'find-image', sources: [], candidates: [{ id: 'restored', title: 'Restored photo', imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Plate.jpg', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Plate.jpg', width: 640, height: 320, sha256: 'a'.repeat(64) }] }
  const choose = vi.fn().mockResolvedValue(undefined)
  render(<SpecializedSuggestion suggestion={candidates} plates={[]} blocked={false} accepted={false} selectedCandidateId="restored" onSelectImage={choose} />)
  expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(true)
  expect(screen.getByText(/Your Batch changes only when you apply the run/)).toBeTruthy()
  const button = screen.getByRole('button', { name: 'Use selected image for this run' }) as HTMLButtonElement
  expect(button.disabled).toBe(false)
  fireEvent.click(button)
  await waitFor(() => expect(choose).toHaveBeenCalledWith('restored'))
  expect(mocks.edit).not.toHaveBeenCalled()
})
