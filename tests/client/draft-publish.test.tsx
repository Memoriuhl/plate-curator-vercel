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
  keepDraftValues: vi.fn(),
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
  useReviewActions: () => ({
    publish: mocks.publish,
    keepDraftValues: mocks.keepDraftValues,
  }),
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
  mocks.keepDraftValues.mockReset().mockResolvedValue({ ok: true })
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
    { interruptedRelease: { id: 'release-4', revision: 4 } },
    'Revision 4 stopped after preparing its Snapshot. Open that release to retry or abandon it.',
  ],
  [
    {
      conflicts: [
        {
          kind: 'field',
          plateId: 'AK.one',
          field: 'tags',
          fromVersion: 7,
          toVersion: 8,
        },
      ],
    },
    'Changes made outside this draft touched values it would publish. Check the conflicts below.',
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

test('an outside catalog change lists each conflict, links to Review and lets the Owner keep the draft values', async () => {
  mocks.view = view({
    canPublish: false,
    conflicts: [
      {
        kind: 'field',
        plateId: 'AK.one',
        field: 'tags',
        fromVersion: 7,
        toVersion: 8,
      },
      { kind: 'order', state: 'AL', fromVersion: 7, toVersion: 8 },
    ],
  })
  render(<DraftPublish draftId="shared-draft-test" />)
  const alert = within(
    screen.getByText(
      'The live Catalog changed values this draft would publish.'
    ).parentElement!
  )
  expect(
    alert.getByText(/AK\.one · tags: Catalog v8 changed it after v7\./)
  ).toBeTruthy()
  expect(
    alert.getByText(/AL plate order: Catalog v8 changed it after v7\./)
  ).toBeTruthy()
  expect(
    alert.getByRole('link', { name: 'Review AK' }).getAttribute('href')
  ).toBe('/review?state=AK')
  fireEvent.click(
    alert.getByRole('button', { name: "Keep the draft's values" })
  )
  await waitFor(() =>
    expect(mocks.keepDraftValues).toHaveBeenCalledExactlyOnceWith(
      'shared-draft-test',
      7
    )
  )
  expect(mocks.mutate).toHaveBeenCalled()
})

test('an untraceable catalog move and a removed plate say what the Owner must review', () => {
  mocks.view = view({
    canPublish: false,
    conflicts: [
      { kind: 'catalog', fromVersion: 7, toVersion: 9 },
      {
        kind: 'removed',
        plateId: 'AK.one',
        fields: { tags: ['draft'], description: 'Draft text' },
        fromVersion: 7,
        toVersion: 9,
      },
    ],
  })
  render(<DraftPublish draftId="shared-draft-test" />)
  const alert = within(
    screen.getByText(
      'The live Catalog changed values this draft would publish.'
    ).parentElement!
  )
  expect(
    alert.getByText(
      /^Catalog changed outside the draft between v7 and v9: review conflicts/
    )
  ).toBeTruthy()
  expect(
    alert.getByText(
      'AK.one: Catalog v9 removed this plate, so its pending tags, description cannot be published.'
    )
  ).toBeTruthy()
  expect(alert.queryByRole('link')).toBeNull()
})

test('a removed plate shows its pending values and the keep button says they will be omitted', async () => {
  mocks.view = view({
    canPublish: false,
    conflicts: [
      {
        kind: 'removed',
        plateId: 'AK.one',
        fields: { tags: ['draft'], description: 'Draft text' },
        fromVersion: 7,
        toVersion: 9,
      },
    ],
  })
  render(<DraftPublish draftId="shared-draft-test" />)
  const alert = within(
    screen.getByText(
      'The live Catalog changed values this draft would publish.'
    ).parentElement!
  )
  const removed = within(
    alert.getByText(
      "These edits will be omitted if you keep the draft's values:"
    ).parentElement!
  )
  expect(removed.getByText('Description')).toBeTruthy()
  expect(removed.getByText('Draft text')).toBeTruthy()
  expect(removed.getByText('Tags')).toBeTruthy()
  expect(removed.getByText('draft')).toBeTruthy()
  fireEvent.click(
    alert.getByRole('button', {
      name: "Keep the draft's values and omit the removed plates' edits",
    })
  )
  await waitFor(() =>
    expect(mocks.keepDraftValues).toHaveBeenCalledExactlyOnceWith(
      'shared-draft-test',
      7
    )
  )
})

test('a release that stopped after preparing its Snapshot links to its recovery page', () => {
  mocks.view = view({
    canPublish: false,
    interruptedRelease: { id: 'release-4', revision: 4 },
  })
  render(<DraftPublish draftId="shared-draft-test" />)
  expect(
    screen.getByRole('link', { name: 'Open release' }).getAttribute('href')
  ).toContain('release-4')
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
