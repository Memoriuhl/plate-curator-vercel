// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PublishWorkspace } from '../components/publish/workspace'
import { ApiError } from '../lib/client/api'
import { batch, command, fixture } from './publish/fixture'
import { publishBaselineStatus } from '../lib/publish/baseline-status'

const mocks = vi.hoisted(() => ({ copy: vi.fn(), push: vi.fn(), live: 2, run: false, runError: 'stale_baseline', baselineError: undefined as string | null | undefined }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('../lib/client/hooks', () => ({
  useMe: () => ({ data: { role: 'owner' } }),
  useBatch: () => ({ data: { batch, plates: [] } }),
  useBatches: () => ({ data: [batch] }),
  useBatchRun: () => ({ data: mocks.run ? { phase: 'failed', outcome: { error: mocks.runError, reviewedVersion: 1, liveVersion: 2 } } : { phase: 'waiting-for-publish' } }),
  usePublishBaseline: () => ({ data: { error: mocks.baselineError !== undefined ? mocks.baselineError : mocks.run ? null : 'stale_baseline', reviewedVersion: 1, liveVersion: mocks.live } }),
  usePlateDetail: () => ({}),
  useReviewActions: () => ({ copy: mocks.copy }),
}))
beforeEach(() => { vi.clearAllMocks(); mocks.live = 2; mocks.run = false; mocks.runError = 'stale_baseline'; mocks.baselineError = undefined; mocks.copy.mockResolvedValue({ id: 'fresh' }) })
afterEach(cleanup)

test.each([false, true])('Owner sees reviewed and live versions and opens a fresh review (Workflow failure: %s)', async failedRun => {
  mocks.run = failedRun
  render(<PublishWorkspace />)
  expect(screen.getAllByText(/Reviewed Catalog v1; current Catalog v2/).length).toBeGreaterThan(0)
  expect(screen.queryByRole('button', { name: 'Publish revision 1' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Copy to new Batch' }))
  await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith(batch.id, 2, 2))
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/review?batch=fresh'))
})

test('a head race requires another explicit copy request with the new version', async () => {
  mocks.copy.mockRejectedValueOnce(new ApiError(409, 'head_moved', { liveVersion: 3 }))
  render(<PublishWorkspace />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy to new Batch' }))
  await screen.findByText(/The Catalog moved to v3/)
  expect(mocks.push).not.toHaveBeenCalled()
  expect(mocks.copy).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Copy to new Batch' }))
  await waitFor(() => expect(mocks.copy).toHaveBeenLastCalledWith(batch.id, 2, 3))
})

test('incompatible proposals display affected items and retain the original Batch', async () => {
  mocks.copy.mockRejectedValueOnce(new ApiError(409, 'incompatible', { reasons: ['Missing Plate: one', 'State order no longer matches Jurisdiction: CA'] }))
  render(<PublishWorkspace />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy to new Batch' }))
  await screen.findByText('Missing Plate: one')
  expect(screen.getByText('State order no longer matches Jurisdiction: CA')).toBeTruthy()
  expect(screen.getByText(/The original Batch is preserved/)).toBeTruthy()
  expect(mocks.push).not.toHaveBeenCalled()
})

test('copy service unavailability gives a retry message without navigating away', async () => {
  mocks.copy.mockRejectedValueOnce(new ApiError(503, 'unavailable', {}))
  render(<PublishWorkspace />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy to new Batch' }))
  await screen.findByText('The current Catalog is temporarily unavailable. Try Copy to new Batch again.')
  expect(mocks.push).not.toHaveBeenCalled()
})


test('a pointer_moved failure with an effectively stale baseline offers Copy to new Batch', async () => {
  const f = fixture()
  f.records.set('batch@2', { id: 'batch@2', ...command, fromVersion: 1, toVersion: 2, blobSha256: 'old', state: 'failed', failure: 'pointer_moved' })
  f.deps.pointer.read = async () => ({ version: 2 })
  mocks.run = true
  mocks.runError = 'pointer_moved'
  mocks.baselineError = (await publishBaselineStatus(f.deps, batch)).error
  render(<PublishWorkspace />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy to new Batch' }))
  await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith(batch.id, 2, 2))
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/review?batch=fresh'))
})
