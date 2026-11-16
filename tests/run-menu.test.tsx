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
import { RunMenu } from '../components/dashboard/run-menu'
import { TagRunBanner } from '../components/dashboard/tag-run-banner'
import {
  useTagRun,
  type RunEntry,
  type RunPlate,
} from '../components/dashboard/use-tag-run'
import { ApiError } from '../lib/client/api'

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), send: vi.fn() },
  ensure: vi.fn(),
  edit: vi.fn(),
  detail: { plates: [] as { proposed: RunPlate }[] },
}))
vi.mock('../lib/client/session', () => ({
  useSession: () => ({ api: mocks.api }),
}))
vi.mock('../lib/client/hooks', () => ({
  useEnsureBatch: () => mocks.ensure,
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
  expect(start).toHaveBeenCalledWith(plates.slice(0, 25))
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
  expect(start).toHaveBeenCalledWith([plate])
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
  })
})
