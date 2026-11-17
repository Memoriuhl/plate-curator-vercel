import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { CopyRecovery } from '../../components/publish/copy-recovery'
import type { ReviewBatch } from '../../lib/review/types'

const actions = vi.hoisted(() => ({ copy: vi.fn(), push: vi.fn() }))
vi.mock('../../lib/client/hooks', () => ({ useReviewActions: () => ({ copy: actions.copy }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: actions.push }) }))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: import('react').ReactNode }) => <a href={href}>{children}</a> }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const batch: ReviewBatch = { id: 'source', name: 'Source', createdBy: 'owner', createdByName: null, createdAt: '', state: 'approved', revision: 2, baselineVersion: 1, stateOrders: {}, plateIds: [], approval: null }

test('copy warnings show the repair reasons and a link to the created Batch', async () => {
  actions.copy.mockResolvedValue({ ...batch, id: 'copy', state: 'open', warnings: ['AK: make Gold the Standard.'] })
  render(<CopyRecovery batch={batch} liveVersion={2} receiptConflict={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy to new Batch' }))
  await screen.findByText('AK: make Gold the Standard.')
  expect(screen.getByRole('link', { name: 'Open copied Batch' }).getAttribute('href')).toBe('/review?batch=copy')
  expect(actions.push).not.toHaveBeenCalled()
})
test('a copy without warnings opens the new Batch immediately', async () => {
  actions.copy.mockResolvedValue({ ...batch, id: 'copy' })
  render(<CopyRecovery batch={batch} liveVersion={2} receiptConflict={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy to new Batch' }))
  await waitFor(() => expect(actions.push).toHaveBeenCalledWith('/review?batch=copy'))
})
