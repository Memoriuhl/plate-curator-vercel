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
import {
  DraftPublish,
  draftPublishBlocker,
} from '../../components/publish/draft-publish'
import type { DraftPublishView } from '../../lib/client/hooks'

const mocks = vi.hoisted(() => ({
  view: undefined as DraftPublishView | undefined,
  error: undefined as Error | undefined,
  publish: vi.fn(),
  mutate: vi.fn(),
}))
vi.mock('../../lib/client/hooks', () => ({
  /** Serve the fixture Publish view in place of the polled request. */
  useDraftPublishView: () => ({
    data: mocks.view,
    error: mocks.error,
    mutate: mocks.mutate,
  }),
  /** Record Publish requests so tests can check the confirmed revision. */
  useReviewActions: () => ({ publish: mocks.publish }),
}))
vi.mock('../../components/review/run-status', () => ({
  RunStatus: () => <p>Release run</p>,
}))

/** Build a Publish view of a draft with changes in two states. */
function view(overrides: Partial<DraftPublishView> = {}): DraftPublishView {
  return {
    draftId: 'shared-draft-test',
    draftRevision: 7,
    baselineVersion: 12,
    liveVersion: 12,
    destination: 'license-plate-game-staging',
    enabledHere: true,
    states: [
      { state: 'AK', plates: 0, moved: 3, contributors: ['Dana'] },
      {
        state: 'AL',
        plates: 2,
        moved: 0,
        contributors: ['Plate Pipeline', 'Lee'],
      },
    ],
    pipeline: { busy: false, activeRuns: 0 },
    approvalProblems: [],
    canPublish: true,
    ...overrides,
  }
}

beforeEach(() => {
  mocks.view = view()
  mocks.error = undefined
  mocks.publish.mockReset().mockResolvedValue({ ok: true })
  mocks.mutate.mockReset().mockResolvedValue(undefined)
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  })
})
afterEach(cleanup)

test('the Publish view lists every changed state with its counts and contributors', () => {
  render(<DraftPublish draftId="shared-draft-test" />)
  expect(screen.getByText(/Revision 7 · based on Catalog v12/)).toBeTruthy()
  const table = within(screen.getByRole('table'))
  expect(
    table.getByText('Changes by state · Publish ships every state together')
  ).toBeTruthy()
  const rows = table.getAllByRole('row').slice(1)
  expect(rows.map((row) => row.textContent)).toEqual([
    'AK03Dana',
    'AL20Plate Pipeline, Lee',
  ])
  expect(table.getByRole('link', { name: 'AL' }).getAttribute('href')).toBe(
    '/review?state=AL'
  )
  // No per-state hold-back: Publish is one action for the whole draft.
  expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  expect(
    screen
      .getByRole('link', { name: 'Review unpublished changes' })
      .getAttribute('href')
  ).toBe('/review')
})

test('a busy pipeline says why Publish waits, how many runs remain and where to watch them', () => {
  mocks.view = view({
    canPublish: false,
    pipeline: { busy: true, activeRuns: 3 },
  })
  render(<DraftPublish draftId="shared-draft-test" />)
  const button = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Publish revision 7',
  })
  expect(button.disabled).toBe(true)
  const notice = document.getElementById(
    button.getAttribute('aria-describedby')!
  )!
  expect(notice.textContent).toContain('Publish waits for the Plate Pipeline.')
  expect(notice.textContent).toContain('3 runs are queued or running.')
  expect(
    within(notice)
      .getByRole('link', { name: 'Open pipeline runs' })
      .getAttribute('href')
  ).toBe('/?pipeline=open')
})

test('one remaining run reads in the singular', () => {
  mocks.view = view({
    canPublish: false,
    pipeline: { busy: true, activeRuns: 1 },
  })
  render(<DraftPublish draftId="shared-draft-test" />)
  expect(screen.getByText(/1 run is queued or running\./)).toBeTruthy()
})

test.each<[Partial<DraftPublishView>, string]>([
  [{ enabledHere: false }, 'Publishing is disabled in this environment.'],
  [
    { states: [] },
    'The draft has no changes to publish. Edit plates on the Dashboard.',
  ],
  [
    { approvalProblems: ['AK: make Navy the Standard.'] },
    'Resolve the Standard plate issues below before publishing.',
  ],
  [
    { activeRelease: { id: 'release-5', revision: 5 } },
    'Publishing revision 5. Wait for it to finish.',
  ],
  [
    { error: 'stale_baseline' },
    'The Catalog changed since the draft was last read. Refresh to move the draft onto the current version.',
  ],
  [
    { error: 'paused' },
    'Catalog publishing is paused. Use Resume publishing to allow new requests.',
  ],
])('a blocked draft explains itself: %o', (overrides, message) => {
  const blocked = view({ ...overrides, canPublish: false })
  expect(draftPublishBlocker(blocked)).toBe(message)
  mocks.view = blocked
  render(<DraftPublish draftId="shared-draft-test" />)
  const button = screen.getByRole<HTMLButtonElement>('button', {
    name: /Publish revision/,
  })
  expect(button.disabled).toBe(true)
  expect(
    document.getElementById(button.getAttribute('aria-describedby')!)
      ?.textContent
  ).toBe(message)
})

test('Publish ships the revision the Owner confirmed, even after the draft moves on', async () => {
  const page = render(<DraftPublish draftId="shared-draft-test" />)
  fireEvent.click(screen.getByRole('button', { name: 'Publish revision 7' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('2 plates across AK, AL.')).toBeTruthy()
  // A curator saves while the dialog is open: the confirmed revision stays 7.
  mocks.view = view({ draftRevision: 9 })
  page.rerender(<DraftPublish draftId="shared-draft-test" />)
  expect(
    dialog.getByText(
      'The draft moved to revision 9 since you opened this. Publish ships revision 7; the later edits stay in the draft.'
    )
  ).toBeTruthy()
  fireEvent.click(dialog.getByRole('button', { name: 'Publish revision 7' }))
  await waitFor(() =>
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith(
      'shared-draft-test',
      7
    )
  )
  expect(
    await screen.findByText(
      'Publish requested for revision 7. Waiting for the run…'
    )
  ).toBeTruthy()
  expect(mocks.mutate).toHaveBeenCalled()
})

test('a refused Publish shows the server message', async () => {
  mocks.publish.mockResolvedValue({
    ok: false,
    message: 'Pipeline work is queued or running.',
  })
  render(<DraftPublish draftId="shared-draft-test" />)
  fireEvent.click(screen.getByRole('button', { name: 'Publish revision 7' }))
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Publish revision 7',
    })
  )
  expect(
    await screen.findByText('Pipeline work is queued or running.')
  ).toBeTruthy()
})

test('the last publish names who published which revision', () => {
  mocks.view = view({
    lastPublish: {
      releaseId: 'release-4',
      revision: 4,
      version: 12,
      by: 'owner-uid',
      byName: 'Jordan',
      at: '2026-11-18T10:00:00Z',
    },
  })
  render(<DraftPublish draftId="shared-draft-test" />)
  expect(
    screen.getByText(/Last published revision 4 as v12 by Jordan on/)
  ).toBeTruthy()
})

test('a failed load offers a refresh', () => {
  mocks.view = undefined
  mocks.error = new Error('offline')
  render(<DraftPublish draftId="shared-draft-test" />)
  expect(screen.getByRole('alert').textContent).toBe(
    'Could not load the shared draft.'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(mocks.mutate).toHaveBeenCalledOnce()
})
