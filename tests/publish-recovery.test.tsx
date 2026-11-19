// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PublishButton } from '../components/dashboard/publish-button'
import { PublishWorkspace } from '../components/publish/workspace'
import { ApiError } from '../lib/client/api'
import { batch, command, fixture } from './publish/fixture'
import { publishBaselineStatus } from '../lib/publish/baseline-status'

const mocks = vi.hoisted(() => ({
  query: '',
  selectedState: 'approved' as import('../lib/review/types').BatchState,
  kind: undefined as import('../lib/review/types').ReviewBatch['kind'],
  empty: false,
  pipelineBusy: false,
  enabledHere: true,
  readBatch: vi.fn(),
  refresh: vi.fn(),
  listLoading: false,
  retryReason: 'locked',
  approvalProblems: [] as string[],
  confirmation: null as import('../lib/review/checkpoint').ReviewChanges | null,
  healthy: false,
  abandon: vi.fn(),
  prepared: false,
  disposition: false,
  runId: 'old-run',
  publish: vi.fn(),
  canRetry: true,
  phase: 'failed',
  role: 'owner',
  copy: vi.fn(),
  push: vi.fn(),
  live: 2,
  run: false,
  runError: 'stale_baseline',
  baselineError: undefined as string | null | undefined,
}))
vi.mock('../lib/client/live-signal', () => ({
  useBatchRevisionSignal: () => 'Live',
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mocks.query),
  useRouter: () => ({ push: mocks.push, replace: vi.fn() }),
}))
vi.mock('../lib/client/hooks', () => ({
  /** Supply the publish controls for the current workspace scenario. */
  usePublishControl: () => ({
    data: { control: null },
    change: async () => {},
  }),
  /** Supply the current fixture actor for role and account-dependent behavior. */
  useMe: () => ({ data: { role: mocks.role } }),
  /** Provide batch detail from the fixture in place of an SWR request. */
  useBatch: (id: string) => {
    mocks.readBatch(id)
    if (id !== batch.id)
      return {
        error: new ApiError(404, 'not_found', {}),
        mutate: mocks.refresh,
      }
    const baseline = {
      id: 'one',
      state: 'AK',
      slug: 'one',
      displayName: 'One',
      image: '',
      tags: [],
    }
    return {
      data: {
        batch: { ...batch, state: mocks.selectedState, kind: mocks.kind },
        plates: mocks.empty
          ? []
          : [
              {
                baseline,
                proposed: { ...baseline, tags: ['changed'] },
                edit: { fields: { tags: ['changed'] } },
              },
            ],
      },
      mutate: mocks.refresh,
    }
  },
  /** Provide the batch list for the current workspace scenario. */
  useBatches: () => ({
    data: mocks.listLoading
      ? undefined
      : [{ ...batch, state: mocks.selectedState }],
    isLoading: mocks.listLoading,
  }),
  /** Supply the workflow phase used by the fixture batch view. */
  useBatchRun: () => ({
    data: mocks.run
      ? {
          runId: mocks.runId,
          phase: mocks.phase,
          outcome: {
            error: mocks.runError,
            reviewedVersion: 1,
            liveVersion: 2,
          },
        }
      : { phase: 'waiting-for-publish' },
    mutate: mocks.refresh,
  }),
  /**
   * Supply the baseline mismatch or prepared receipt for the current publish recovery
   * case.
   */
  usePublishBaseline: () => ({
    mutate: mocks.refresh,
    data: {
      batchRevision: mocks.confirmation?.revision ?? batch.revision,
      confirmation: mocks.confirmation ?? {
        revision: batch.revision,
        since: null,
        plateCount: 0,
        contributors: [],
      },
      enabledHere: mocks.enabledHere,
      destination: 'license-plate-game-staging',
      pipelineBusy: mocks.pipelineBusy,
      approvalProblems: mocks.approvalProblems,
      ...(mocks.prepared
        ? {
            error: 'paused',
            canRetry: false,
            canAbandon: !mocks.healthy,
            abandonReason: mocks.healthy ? 'locked' : null,
            prepared: { commandId: 'command', toVersion: 2 },
            ...(mocks.disposition
              ? {
                  abandonment: {
                    by: { email: 'owner@example.com' },
                    at: '2026-11-15T12:00:00Z',
                    burnedVersion: 2,
                  },
                }
              : {}),
          }
        : {
            canConfirmDraft:
              mocks.selectedState !== 'approved' &&
              !mocks.empty &&
              mocks.approvalProblems.length === 0,
            canRetry: mocks.selectedState === 'approved' && mocks.canRetry,
            retryReason: mocks.canRetry ? null : mocks.retryReason,
            error:
              mocks.baselineError !== undefined
                ? mocks.baselineError
                : mocks.run
                  ? null
                  : 'stale_baseline',
            reviewedVersion: 1,
            liveVersion: mocks.live,
          }),
    },
  }),
  /** Keep plate detail unloaded while testing recovery controls. */
  usePlateDetail: () => ({}),
  /** Provide controllable batch actions so the test can inspect user requests. */
  useReviewActions: () => ({
    copy: mocks.copy,
    publish: mocks.publish,
    abandon: mocks.abandon,
  }),
  /** Name the shared draft Publish opens without a linked Batch. */
  useSharedDraftId: () => 'shared-draft-test',
  /** Keep the shared draft unloaded; these cases cover releases and older Batches. */
  useDraftPublishView: () => ({ mutate: mocks.refresh }),
}))
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(mocks, {
    // Recovery covers a release or an older Batch opened from Publish history.
    query: 'batch=batch',
    selectedState: 'approved',
    kind: undefined,
    empty: false,
    listLoading: false,
    pipelineBusy: false,
    enabledHere: true,
    retryReason: 'locked',
    approvalProblems: [],
    confirmation: null,
    healthy: false,
    prepared: false,
    disposition: false,
    runId: 'old-run',
    canRetry: true,
    phase: 'failed',
    role: 'owner',
    live: 2,
    run: false,
    runError: 'stale_baseline',
    baselineError: undefined,
  })
  mocks.abandon.mockResolvedValue(undefined)
  mocks.publish.mockResolvedValue({ ok: true })
  mocks.copy.mockResolvedValue({ id: 'fresh' })
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
})
afterEach(cleanup)

test('a healthy live Publish shows neither Prepared Snapshot nor Abandon', () => {
  mocks.prepared = true
  mocks.healthy = true
  render(<PublishWorkspace />)
  expect(
    screen.queryByRole('region', { name: 'Prepared Snapshot recovery' })
  ).toBeNull()
  expect(screen.queryByText(/Prepared Snapshot v2/)).toBeNull()
  expect(
    screen.queryByRole('button', { name: 'Abandon prepared Snapshot' })
  ).toBeNull()
})

test('eligible Owner can abandon while paused and sees the burned disposition', async () => {
  mocks.prepared = true
  const view = render(<PublishWorkspace />)
  fireEvent.change(screen.getByLabelText('Reason for abandonment'), {
    target: { value: 'Publish another Batch' },
  })
  fireEvent.click(
    screen.getByRole('button', { name: 'Abandon prepared Snapshot' })
  )
  await waitFor(() =>
    expect(mocks.abandon).toHaveBeenCalledWith(
      batch.id,
      2,
      'command',
      'Publish another Batch'
    )
  )
  mocks.disposition = true
  view.rerender(<PublishWorkspace />)
  expect(screen.getByText(/owner@example.com.*burned v2/)).toBeTruthy()
})

test('abandon refusal explains the live-run race', async () => {
  mocks.prepared = true
  mocks.abandon.mockRejectedValue(new ApiError(409, 'locked', {}))
  render(<PublishWorkspace />)
  fireEvent.change(screen.getByLabelText('Reason for abandonment'), {
    target: { value: 'Choose B' },
  })
  fireEvent.click(
    screen.getByRole('button', { name: 'Abandon prepared Snapshot' })
  )
  expect(
    await screen.findByText(/A live Publish run or lease owns this attempt/)
  ).toBeTruthy()
})

test('server eligibility permits another click after the fresh run ends without a stop reason', async () => {
  mocks.run = true
  mocks.runError = 'paused'
  mocks.baselineError = null
  const view = render(<PublishWorkspace />)
  fireEvent.click(screen.getByRole('button', { name: 'Publish again' }))
  fireEvent.click(
    view.container.querySelector('dialog button[data-variant="publish"]')!
  )
  await waitFor(() =>
    expect(mocks.publish).toHaveBeenCalledWith(batch.id, batch.revision)
  )
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Publish again' })).toBeNull()
  )
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

test.each([false, true])(
  'Owner sees reviewed and live versions and is sent to the shared draft (Workflow failure: %s)',
  (failedRun) => {
    mocks.run = failedRun
    render(<PublishWorkspace />)
    expect(
      screen.getAllByText(/Reviewed Catalog v1; current Catalog v2/).length
    ).toBeGreaterThan(0)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Publish to Game' })
        .disabled
    ).toBe(true)
    // Copy to new Batch is retired: the changes are still in the shared draft.
    expect(screen.queryByRole('button', { name: 'Copy to new Batch' })).toBeNull()
    expect(
      screen.getByText(/baseline changed. These changes are still in/)
    ).toBeTruthy()
    expect(
      screen
        .getByRole('link', { name: 'the shared draft' })
        .getAttribute('href')
    ).toBe('/publish')
    expect(mocks.copy).not.toHaveBeenCalled()
  }
)

test('a pointer_moved failure with an effectively stale baseline points to the shared draft', async () => {
  const f = fixture()
  f.records.set('batch@2', {
    id: 'batch@2',
    ...command,
    fromVersion: 1,
    toVersion: 2,
    blobSha256: 'old',
    state: 'failed',
    failure: 'pointer_moved',
  })
  f.deps.pointer.read = async () => ({ version: 2 })
  mocks.run = true
  mocks.runError = 'pointer_moved'
  mocks.baselineError = (await publishBaselineStatus(f.deps, batch)).error
  render(<PublishWorkspace />)
  expect(screen.queryByRole('button', { name: 'Copy to new Batch' })).toBeNull()
  expect(screen.getByRole('link', { name: 'the shared draft' })).toBeTruthy()
})

test('a stopped command leaves the approved Batch visible and requires a fresh Publish request', () => {
  mocks.run = true
  mocks.runError = 'paused'
  mocks.baselineError = null
  render(<PublishWorkspace />)
  expect(screen.getAllByText(batch.name).length).toBeGreaterThan(0)
  expect(
    screen.getByText(
      /The changes stay in the shared draft. Resume does not restart this command/
    )
  ).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Publish to Game' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Copy to new Batch' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Publish again' })).toBeTruthy()
})

test('paused Publish explains the stop; after Resume a stale release points to the shared draft', () => {
  mocks.baselineError = 'paused'
  const view = render(<PublishWorkspace />)
  expect(
    screen.getByText(
      'Catalog publishing is paused. Use Resume publishing to allow new requests.'
    )
  ).toBeTruthy()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Publish to Game' })
      .disabled
  ).toBe(true)
  expect(screen.queryByRole('link', { name: 'the shared draft' })).toBeNull()
  mocks.baselineError = 'stale_baseline'
  view.rerender(<PublishWorkspace />)
  expect(screen.getByRole('link', { name: 'the shared draft' })).toBeTruthy()
})

test.each([
  'paused',
  'stale_baseline',
  'editor',
  'unauthenticated',
  'publishing',
])('Publish again is hidden when ineligible: %s', (condition) => {
  mocks.run = true
  mocks.runError = 'revoked'
  mocks.baselineError =
    condition === 'paused' || condition === 'stale_baseline' ? condition : null
  if (condition === 'editor' || condition === 'unauthenticated')
    mocks.role = condition
  if (condition === 'publishing') mocks.phase = 'publishing'
  mocks.canRetry = false
  render(<PublishWorkspace />)
  expect(screen.queryByRole('button', { name: 'Publish again' })).toBeNull()
  if (condition === 'stale_baseline')
    expect(screen.getByRole('link', { name: 'the shared draft' })).toBeTruthy()
})

test('Editor cannot enter Publish or trigger Batch preflight', () => {
  mocks.role = 'editor'
  render(
    <>
      <PublishButton batchId="batch" owner={false} />
      <PublishWorkspace />
    </>
  )
  expect(screen.getByText('Only the Owner can Publish.')).toBeTruthy()
  expect(screen.queryByRole('link', { name: 'Publish' })).toBeNull()
  expect(mocks.readBatch).not.toHaveBeenCalled()
})

test.each(['open', 'approved'] as const)(
  'Owner can explicitly confirm the exact %s release for staging',
  async (state) => {
    mocks.query = 'batch=batch'
    mocks.listLoading = true
    mocks.selectedState = state
    // A release frozen from the shared draft starts open; an approved one is retrying.
    if (state === 'open') mocks.kind = 'release'
    mocks.baselineError = null
    if (state === 'approved') {
      mocks.canRetry = false
      mocks.retryReason = 'not_waiting'
    }
    render(<PublishWorkspace />)
    expect(screen.getByRole('heading', { name: batch.name })).toBeTruthy()
    expect(
      screen.getByRole('link', { name: 'Review Batch' }).getAttribute('href')
    ).toBe('/review?batch=batch')
    fireEvent.click(screen.getByRole('button', { name: 'Publish to Game' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(
      dialog.getByText(
        /next Snapshot for Staging Catalog \(license-plate-game-staging\)/
      )
    ).toBeTruthy()
    expect(
      dialog.getByText(
        state === 'approved'
          ? 'This uses the current Owner approval.'
          : 'Confirm these draft changes for release.'
      )
    ).toBeTruthy()
    expect(mocks.publish).not.toHaveBeenCalled()
    fireEvent.click(dialog.getByRole('button', { name: 'Publish revision 2' }))
    await waitFor(() =>
      expect(mocks.publish).toHaveBeenCalledExactlyOnceWith('batch', 2)
    )
  }
)

test('an unavailable direct link stays on its requested Batch even with an approved alternative', () => {
  mocks.query = 'batch=missing'
  render(<PublishWorkspace />)
  expect(screen.getByRole('alert').textContent).toContain(
    'This Batch is unavailable.'
  )
  expect(
    screen
      .getByRole('link', { name: 'Choose another Batch' })
      .getAttribute('href')
  ).toBe('/publish')
  expect(mocks.readBatch).toHaveBeenCalledExactlyOnceWith('missing')
})

test.each(['open', 'submitted'] as const)(
  'a %s Batch from before the shared draft is read-only and points to the draft',
  (state) => {
    mocks.selectedState = state
    mocks.baselineError = null
    render(<PublishWorkspace />)
    expect(
      screen.getByText(/This Batch is from before the shared draft/)
    ).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Publish to Game' })
        .disabled
    ).toBe(true)
    expect(
      screen
        .getByRole('link', { name: 'Open the shared draft' })
        .getAttribute('href')
    ).toBe('/publish')
  }
)

test('blocked releases expose the shared draft and refresh actions', () => {
  mocks.query = 'batch=batch'
  mocks.selectedState = 'open'
  mocks.kind = 'release'
  mocks.baselineError = null
  mocks.empty = true
  const view = render(<PublishWorkspace />)
  expect(screen.getByText(/no changes to publish/)).toBeTruthy()
  expect(
    screen
      .getByRole('link', { name: 'Open the shared draft' })
      .getAttribute('href')
  ).toBe('/publish')
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Publish to Game' })
      .disabled
  ).toBe(true)

  mocks.empty = false
  mocks.pipelineBusy = true
  view.rerender(<PublishWorkspace />)
  expect(screen.getByText(/Pipeline work is queued or running/)).toBeTruthy()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Publish to Game' })
      .disabled
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Batch' }))
  expect(mocks.refresh).toHaveBeenCalled()

  mocks.pipelineBusy = false
  mocks.approvalProblems = ['AK: make Navy the Standard.']
  view.rerender(<PublishWorkspace />)
  expect(screen.getByText('AK: make Navy the Standard.')).toBeTruthy()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Publish to Game' })
      .disabled
  ).toBe(true)

  mocks.approvalProblems = []
  view.rerender(<PublishWorkspace />)
  expect(screen.getByRole('button', { name: 'Publish to Game' })).toBeTruthy()
})

test('an approved Batch cannot confirm when the deployment disallows Publish', () => {
  mocks.enabledHere = false
  mocks.baselineError = null
  render(<PublishWorkspace />)
  expect(
    screen.getByText('Publishing is disabled in this environment.')
  ).toBeTruthy()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Publish to Game' })
      .disabled
  ).toBe(true)
})

test('an intervening edit refreshes the warning and requires a new explicit confirmation', async () => {
  mocks.baselineError = null
  mocks.publish.mockResolvedValueOnce({
    ok: false,
    code: 'superseded_revision',
    message: 'This Batch changed.',
  })
  const view = render(<PublishWorkspace />)
  fireEvent.click(screen.getByRole('button', { name: 'Publish again' }))
  expect(
    screen.getByText('You haven’t viewed this Batch in Review yet.')
  ).toBeTruthy()
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Publish revision 2',
    })
  )
  await screen.findByText(/This Batch changed. Review the latest changes/)
  expect(
    within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', {
      name: 'Publish revision 2',
    }).disabled
  ).toBe(true)
  expect(mocks.publish).toHaveBeenCalledTimes(1)

  const previous = batch.revision
  try {
    batch.revision += 1
    mocks.selectedState = 'open'
    mocks.kind = 'release'
    mocks.confirmation = {
      revision: previous + 1,
      since: previous,
      plateCount: 2,
      contributors: ['Dana Curator'],
    }
    view.rerender(<PublishWorkspace />)
    expect(screen.getByText(/2 Plates changed.*Dana Curator/)).toBeTruthy()
    expect(
      screen
        .getByRole('link', { name: 'Review new changes' })
        .getAttribute('href')
    ).toBe('/review?batch=batch&since=2')
    expect(mocks.publish).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Publish anyway' }))
    await waitFor(() =>
      expect(mocks.publish).toHaveBeenLastCalledWith(batch.id, previous + 1)
    )
  } finally {
    batch.revision = previous
  }
})
