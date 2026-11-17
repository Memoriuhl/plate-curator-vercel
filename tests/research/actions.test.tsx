// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { ResearchActions } from '../../components/research/research-actions'
import { plateCards } from '../../fixtures/plate-cards'

const state = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }))
vi.mock('../../lib/client/session', () => ({ useSession: () => ({ user: { uid: 'owner' }, api: state }) }))
vi.mock('../../lib/client/hooks', () => ({ useMe: () => ({ data: { role: 'owner' } }), useWorkspaceBatch: () => ({ mode: 'selected', id: 'batch', status: 'ready' }), useEnsureBatch: () => vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks() })
function view() { return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><ResearchActions plate={plateCards[0]} /></SWRConfig>) }
const job = { id: 'saved', executor: 'desktop', state: 'queued' }

test('host selection is fixed in the start request and restored after a reload', async () => {
 state.send.mockResolvedValue({ ok: true, value: job })
 state.get.mockResolvedValue({ ok: true, value: job })
 const first = view()
 fireEvent.change(screen.getByRole('combobox', { name: 'Research host' }), { target: { value: 'desktop' } })
 fireEvent.click(screen.getByRole('button', { name: 'Research this plate' }))
 await waitFor(() => expect(state.send).toHaveBeenCalledWith('POST', expect.stringContaining('/research'), expect.objectContaining({ executor: 'desktop', requestKey: expect.any(String) })))
 await screen.findByText(/Waiting for the desktop worker/)
 first.unmount()
 view()
 await screen.findByText(/Waiting for the desktop worker/)
 expect(state.send).toHaveBeenCalledTimes(1)
})

test('a lost start response retries its original request key without changing the host', async () => {
 state.send.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, value: job })
 state.get.mockResolvedValue({ ok: true, value: job })
 view()
 fireEvent.click(screen.getByRole('button', { name: 'Research this plate' }))
 const retry = await screen.findByRole('button', { name: 'Retry research request' })
 expect((screen.getByRole('combobox', { name: 'Research host' }) as HTMLSelectElement).disabled).toBe(true)
 fireEvent.click(retry)
 await screen.findByText(/Waiting for the desktop worker/)
 expect(state.send.mock.calls[0][2]).toEqual(state.send.mock.calls[1][2])
})
