// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PublishButton } from '../components/dashboard/publish-button'
import { PublishWorkspace } from '../components/publish/workspace'
import { ApiError } from '../lib/client/api'
import { batch, command, fixture } from './publish/fixture'
import { publishBaselineStatus } from '../lib/publish/baseline-status'

const mocks = vi.hoisted(() => ({ healthy: false, abandon: vi.fn(), prepared: false, disposition: false, runId: 'old-run', publish: vi.fn(), canRetry: true, phase: 'failed', role: 'owner', copy: vi.fn(), push: vi.fn(), live: 2, run: false, runError: 'stale_baseline', baselineError: undefined as string | null | undefined }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: mocks.push }) }))
vi.mock('../lib/client/hooks', () => ({
  usePublishControl: () => ({ data: { control: null }, change: async () => {} }),
  useMe: () => ({ data: { role: mocks.role } }),
  useBatch: () => ({ data: { batch, plates: [] } }),
  useBatches: () => ({ data: [batch] }),
  useBatchRun: () => ({ data: mocks.run ? { runId: mocks.runId, phase: mocks.phase, outcome: { error: mocks.runError, reviewedVersion: 1, liveVersion: 2 } } : { phase: 'waiting-for-publish' } }),
  usePublishBaseline: () => ({ data: mocks.prepared ? { error: 'paused', canRetry: false, canAbandon: !mocks.healthy, abandonReason: mocks.healthy ? 'locked' : null, prepared: { commandId: 'command', toVersion: 2 }, ...(mocks.disposition ? { abandonment: { by: { email: 'owner@example.com' }, at: '2026-11-15T12:00:00Z', burnedVersion: 2 } } : {}) } : mocks.baselineError === 'paused' ? { error: 'paused', canRetry: false } : { canRetry: mocks.canRetry, retryReason: mocks.canRetry ? null : 'locked', error: mocks.baselineError !== undefined ? mocks.baselineError : mocks.run ? null : 'stale_baseline', reviewedVersion: 1, liveVersion: mocks.live } }),
  usePlateDetail: () => ({}),
  useReviewActions: () => ({ copy: mocks.copy, publish: mocks.publish, abandon: mocks.abandon }),
}))
beforeEach(() => { vi.clearAllMocks(); mocks.healthy = false; mocks.prepared = false; mocks.disposition = false; mocks.abandon.mockResolvedValue(undefined); mocks.runId = 'old-run'; mocks.publish.mockResolvedValue({ ok: true }); mocks.canRetry = true; mocks.phase = 'failed'; mocks.role = 'owner'; mocks.live = 2; mocks.run = false; mocks.runError = 'stale_baseline'; mocks.baselineError = undefined; mocks.copy.mockResolvedValue({ id: 'fresh' }) })
afterEach(cleanup)

test('a healthy live Publish shows neither Prepared Snapshot nor Abandon', () => {
  mocks.prepared = true
  mocks.healthy = true
  render(<PublishWorkspace />)
  expect(screen.queryByRole('region', { name: 'Prepared Snapshot recovery' })).toBeNull()
  expect(screen.queryByText(/Prepared Snapshot v2/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Abandon prepared Snapshot' })).toBeNull()
})

test('eligible Owner can abandon while paused and sees the burned disposition', async () => {
  mocks.prepared = true
  const view = render(<PublishWorkspace />)
  fireEvent.change(screen.getByLabelText('Reason for abandonment'), { target: { value: 'Publish another Batch' } })
  fireEvent.click(screen.getByRole('button', { name: 'Abandon prepared Snapshot' }))
  await waitFor(() => expect(mocks.abandon).toHaveBeenCalledWith(batch.id, 2, 'command', 'Publish another Batch'))
  mocks.disposition = true
  view.rerender(<PublishWorkspace />)
  expect(screen.getByText(/owner@example.com.*burned v2/)).toBeTruthy()
})

test('abandon refusal explains the live-run race', async () => {
  mocks.prepared = true
  mocks.abandon.mockRejectedValue(new ApiError(409, 'locked', {}))
  render(<PublishWorkspace />)
  fireEvent.change(screen.getByLabelText('Reason for abandonment'), { target: { value: 'Choose B' } })
  fireEvent.click(screen.getByRole('button', { name: 'Abandon prepared Snapshot' }))
  expect(await screen.findByText(/A live Publish run or lease owns this attempt/)).toBeTruthy()
})

test('server eligibility permits another click after the fresh run ends without a stop reason', async () => {
  mocks.run = true
  mocks.runError = 'paused'
  mocks.baselineError = null
  HTMLDialogElement.prototype.close = vi.fn()
  HTMLDialogElement.prototype.showModal = vi.fn()
  const view = render(<PublishWorkspace />)
  fireEvent.click(screen.getByRole('button', { name: 'Publish again' }))
  fireEvent.click(view.container.querySelector('dialog button[data-variant="publish"]')!)
  await waitFor(() => expect(mocks.publish).toHaveBeenCalledWith(batch.id, batch.revision))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Publish again' })).toBeNull())
  mocks.runId = 'fresh-run'
  mocks.runError = 'invalid_snapshot'
  view.rerender(<PublishWorkspace />)
  expect(screen.getByRole('button', { name: 'Publish again' })).toBeTruthy()
})

test('server eligibility hides Publish again while a live run owns the claim', () => {
  mocks.run = true
  mocks.runError = 'paused'
  mocks.baselineError = null
  mocks.canRetry = false
  const view = render(<PublishWorkspace />)
  expect(screen.queryByRole('button', { name: 'Publish again' })).toBeNull()
  mocks.canRetry = true
  view.rerender(<PublishWorkspace />)
  expect(screen.getByRole('button', { name: 'Publish again' })).toBeTruthy()
})

test.each([false, true])('Owner sees reviewed and live versions and opens a fresh review (Workflow failure: %s)', async failedRun => {
  mocks.run = failedRun
  render(<PublishWorkspace />)
  expect(screen.getAllByText(/Reviewed Catalog v1; current Catalog v2/).length).toBeGreaterThan(0)
  expect(screen.queryByRole('button', { name: 'Publish revision 2' })).toBeNull()
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

test('a stopped command leaves the approved Batch visible and requires a fresh Publish request', () => {
  mocks.run = true
  mocks.runError = 'paused'
  mocks.baselineError = null
  render(<PublishWorkspace />)
  expect(screen.getAllByText(batch.name).length).toBeGreaterThan(0)
  expect(screen.getByText(/The Batch remains approved. Resume does not restart this command/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Publish revision 2' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Copy to new Batch' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Publish again' })).toBeTruthy()
})

test('paused Publish explains the stop; after Resume stale proposals still offer Copy', () => {
  mocks.baselineError = 'paused'
  const view = render(<PublishWorkspace />)
  expect(screen.getByText('Catalog publishing is paused. Resume before requesting Publish.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Publish revision 2' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Copy to new Batch' })).toBeNull()
  mocks.baselineError = 'stale_baseline'
  view.rerender(<PublishWorkspace />)
  expect(screen.getByRole('button', { name: 'Copy to new Batch' })).toBeTruthy()
})

test.each(['paused', 'stale_baseline', 'editor', 'unauthenticated', 'publishing'])('Publish again is hidden when ineligible: %s', condition => {
  mocks.run = true
  mocks.runError = 'revoked'
  mocks.baselineError = condition === 'paused' || condition === 'stale_baseline' ? condition : null
  if (condition === 'editor' || condition === 'unauthenticated') mocks.role = condition
  if (condition === 'publishing') mocks.phase = 'publishing'
  mocks.canRetry = false
  render(<PublishWorkspace />)
  expect(screen.queryByRole('button', { name: 'Publish again' })).toBeNull()
  if (condition === 'stale_baseline') expect(screen.getByRole('button', { name: 'Copy to new Batch' })).toBeTruthy()
})

test('unavailable Publish stays focusable and cancels clicks with an accessible reason', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const view = render(<PublishButton batchId="batch" owner={false} approved />)
  const button = screen.getByRole('button', { name: 'Publish to players: Only Owners can publish' }) as HTMLButtonElement
  expect(button.disabled).toBe(false)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  button.focus()
  expect(document.activeElement).toBe(button)
  expect(fireEvent.click(button)).toBe(false)
  expect(view.container.querySelector('a')).toBeNull()
  cleanup()
  vi.unstubAllGlobals()
})

test('an intervening edit refreshes the warning and requires a new explicit confirmation', async () => {
  mocks.baselineError = null
  mocks.publish.mockResolvedValueOnce({
    ok: false, code: 'superseded_revision', message: 'This Batch changed.',
    confirmation: { revision: batch.revision + 1, since: batch.revision, plateCount: 2, contributors: ['Dana Curator'] },
  })
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', '') })
  const view = render(<PublishWorkspace />)
  fireEvent.click(screen.getByRole('button', { name: 'Publish again' }))
  expect(screen.getByText('You haven’t viewed this Batch in Review yet.')).toBeTruthy()
  fireEvent.click(view.container.querySelector('dialog button[data-variant="publish"]')!)
  expect(await screen.findByText(/2 Plates changed.*Dana Curator/)).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Review new changes' }).getAttribute('href')).toBe('/review?batch=batch&since=2')
  expect(mocks.publish).toHaveBeenCalledTimes(1)

  const previous = batch.revision
  try {
    batch.revision += 1
    view.rerender(<PublishWorkspace />)
    fireEvent.click(screen.getByRole('button', { name: 'Publish anyway' }))
    await waitFor(() => expect(mocks.publish).toHaveBeenLastCalledWith(batch.id, previous + 1))
  } finally {
    batch.revision = previous
  }
})
