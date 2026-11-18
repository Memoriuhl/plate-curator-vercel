// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { ResearchActions } from '../../components/research/research-actions'
import { plateCards } from '../../fixtures/plate-cards'

const state = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }))
vi.mock('../../lib/client/session', () => ({
  /** Supply the fixture session and API client to the component under test. */ useSession:
    () => ({ user: { uid: 'owner' }, api: state }),
}))
vi.mock('../../lib/client/hooks', () => ({
  /** Supply the current fixture actor for role and account-dependent behavior. */ useMe:
    () => ({ data: { role: 'owner' } }),
  /** Supply the selected batch and its editability for this workspace scenario. */ useWorkspaceBatch:
    () => ({ mode: 'selected', id: 'batch', status: 'ready' }),
  /** Resolve the fixture batch without creating one through the API. */ useEnsureBatch:
    () => vi.fn(),
}))
vi.mock('next/navigation', () => ({
  /** Capture or stub navigation so the test can drive routing without Next.js. */ useRouter:
    () => ({ refresh: vi.fn() }),
}))
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
})
/** Render the research actions under an isolated SWR cache for the fixture plate. */
function view() {
  return render(
    <SWRConfig
      value={{
        /** Give the rendered test its own isolated SWR cache. */ provider:
          () => new Map(),
        dedupingInterval: 0,
      }}
    >
      <ResearchActions plate={plateCards[0]} />
    </SWRConfig>
  )
}
const job = { id: 'saved', executor: 'desktop', state: 'queued' }

test('host selection is fixed in the start request and restored after a reload', async () => {
  state.send.mockResolvedValue({ ok: true, value: job })
  state.get.mockResolvedValue({ ok: true, value: job })
  const first = view()
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Research host' }), {
    key: 'ArrowDown',
  })
  fireEvent.click(
    await screen.findByRole('option', { name: 'Desktop / Ollama' })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Research this plate' }))
  await waitFor(() =>
    expect(state.send).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/research'),
      expect.objectContaining({
        executor: 'desktop',
        requestKey: expect.any(String),
      })
    )
  )
  await screen.findByText(/Waiting for the desktop worker/)
  first.unmount()
  view()
  await screen.findByText(/Waiting for the desktop worker/)
  expect(state.send).toHaveBeenCalledTimes(1)
})

test('a lost start response retries its original request key without changing the host', async () => {
  state.send
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ ok: true, value: job })
  state.get.mockResolvedValue({ ok: true, value: job })
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Research this plate' }))
  const retry = await screen.findByRole('button', {
    name: 'Retry research request',
  })
  expect(
    (
      screen.getByRole('combobox', {
        name: 'Research host',
      }) as HTMLSelectElement
    ).disabled
  ).toBe(true)
  fireEvent.click(retry)
  await screen.findByText(/Waiting for the desktop worker/)
  expect(state.send.mock.calls[0][2]).toEqual(state.send.mock.calls[1][2])
})
