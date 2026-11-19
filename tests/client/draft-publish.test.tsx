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
import type { BatchDetail, DraftPublishView } from '../../lib/client/hooks'
import type { Plate } from '../../lib/catalog/types'

const mocks = vi.hoisted(() => ({
  view: undefined as DraftPublishView | undefined,
  error: undefined as Error | undefined,
  detail: undefined as BatchDetail | undefined,
  publish: vi.fn(),
  keepDraftValues: vi.fn(),
  mutate: vi.fn(),
  plateDetail: vi.fn(),
}))
vi.mock('../../lib/client/hooks', () => ({
  /** Serve the fixture Publish view in place of the polled request. */
  useDraftPublishView: () => ({
    data: mocks.view,
    error: mocks.error,
    mutate: mocks.mutate,
  }),
  /** Serve the shared draft's plate entries. */
  useBatch: () => ({ data: mocks.detail, mutate: vi.fn() }),
  /** Sign in as the Owner who changed the family. */
  useMe: () => ({ data: { uid: 'dana-uid', role: 'owner' } }),
  /** Look up a template plate the draft does not touch. */
  usePlateDetail: (id: string | null) => ({ data: mocks.plateDetail(id) }),
  /** Record Publish requests so tests can check the confirmed revision. */
  useReviewActions: () => ({
    publish: mocks.publish,
    keepDraftValues: mocks.keepDraftValues,
  }),
}))

type Entry = BatchDetail['plates'][number]

/** Build a draft entry whose proposal applies the given fields to its baseline. */
function entry(
  id: string,
  name: string,
  proposed: Partial<Plate>,
  extra: Partial<Entry> = {},
  baseline: Partial<Plate> = {}
): Entry {
  const before: Plate = {
    id,
    state: id.split('.')[0],
    slug: id.split('.')[1],
    displayName: name,
    tags: [],
    image: `${id}.webp`,
    ...baseline,
  }
  return {
    baseline: before,
    proposed: { ...before, ...proposed },
    beforeImageUrl: `/img/${id}.webp`,
    afterImageUrl: `/img/${id}.webp`,
    edit: null,
    revision: 'r1',
    ...extra,
  }
}

/** Name who saved an entry. */
const by = (name: string) =>
  ({
    authorId: `${name.toLowerCase()}-uid`,
    authorName: name,
  }) as Entry['edit']

/** A shared draft like the rehearsal one: a family move, tag edits, moves, a no-op. */
function detail(): BatchDetail {
  return {
    batch: {
      id: 'shared-draft-test',
      revision: 7,
      baselineVersion: 12,
      stateOrders: {},
    } as unknown as BatchDetail['batch'],
    plates: [
      entry(
        'AK.air_force',
        'Air Force',
        {
          templateFamily: 'ak_artistic_license',
          variantOfPlateId: 'AK.celebrating_the_arts',
        },
        { edit: by('Dana') },
        { templateFamily: 'ak_veteran', variantOfPlateId: 'AK.army' }
      ),
      entry(
        'AK.celebrating_the_arts',
        'Celebrating the Arts',
        { tags: ['green', 'checkpoint'] },
        { edit: by('Lee') },
        {
          tags: ['green'],
          templateFamily: 'ak_artistic_license',
          templateRole: 'template',
        }
      ),
      entry(
        'AK.pws',
        'PWS',
        { tags: ['seal', 'blue'] },
        { edit: by('Lee'), order: { before: 2, after: 5, total: 44 } },
        { tags: ['seal'] }
      ),
      entry(
        'AK.lions_club',
        'Lions Club',
        {},
        { order: { before: 12, after: 3, total: 44 } }
      ),
      entry('AK.caribou', 'Caribou', {}),
      entry(
        'AL.ag_tag',
        'Ag Tag (Farming Feeds)',
        { tags: ['farm', 'barn', 'navy text', 'flag'] },
        { edit: by('Dana') },
        { tags: ['farm', 'barn'] }
      ),
    ],
  }
}
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
  mocks.detail = detail()
  mocks.plateDetail
    .mockReset()
    .mockImplementation((id: string | null) =>
      id === 'AK.army'
        ? { plate: { id, displayName: 'Army', imageUrl: '/img/AK.army.webp' } }
        : undefined
    )
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

test('the Publish view lists each changed plate under its state with an icon per change', () => {
  render(<DraftPublish draftId="shared-draft-test" />)
  expect(screen.getByText(/Revision 7 · based on Catalog v12/)).toBeTruthy()
  const alaska = within(screen.getByRole('region', { name: 'Alaska changes' }))
  expect(alaska.getByText('3 edited · 2 moved')).toBeTruthy()
  expect(
    alaska
      .getAllByRole('listitem')
      .map((row) => row.querySelector('strong')?.textContent)
  ).toEqual(['Air Force', 'Celebrating the Arts', 'PWS', 'Lions Club'])
  // An entry that changes nothing is not listed.
  expect(screen.queryByText('Caribou')).toBeNull()
  const pws = within(alaska.getAllByRole('listitem')[2])
  expect(
    pws
      .getAllByRole('button', { name: /changed$/ })
      .map((b) => b.getAttribute('aria-label'))
  ).toEqual(['Tags changed', 'Order changed'])
  expect(pws.getByLabelText('Changed by Lee')).toBeTruthy()
  expect(
    alaska.getByRole('link', { name: 'Review AK' }).getAttribute('href')
  ).toBe('/review?state=AK')
  expect(screen.getByRole('region', { name: 'Alabama changes' })).toBeTruthy()
  // No per-state hold-back: Publish is one action for the whole draft.
  expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  expect(
    screen
      .getByRole('link', { name: 'Review unpublished changes' })
      .getAttribute('href')
  ).toBe('/review')
})

test('hovering one change icon shows only that change', () => {
  render(<DraftPublish draftId="shared-draft-test" />)
  const alabama = within(
    screen.getByRole('region', { name: 'Alabama changes' })
  )
  fireEvent.focus(alabama.getByRole('button', { name: 'Tags changed' }))
  const popup = within(
    screen.getByRole('dialog', { name: 'Ag Tag (Farming Feeds): Tags' })
  )
  expect(popup.getByText('2 → 4 tags')).toBeTruthy()
  expect(popup.getByText('+ navy text')).toBeTruthy()
  expect(popup.getByText('+ flag')).toBeTruthy()
})

test('hovering the plate shows every change in one card', () => {
  render(<DraftPublish draftId="shared-draft-test" />)
  fireEvent.focus(screen.getByRole('button', { name: /^PWS/ }))
  const card = within(screen.getByRole('dialog', { name: 'PWS: every change' }))
  expect(card.getByText('1 → 2 tags')).toBeTruthy()
  expect(card.getByText('+ blue')).toBeTruthy()
  expect(card.getByText('#3 → #6 of 44')).toBeTruthy()
  expect(card.getByText('Click for the full before and after')).toBeTruthy()
})

test("a family change shows each family's template plate with its name above it", () => {
  render(<DraftPublish draftId="shared-draft-test" />)
  fireEvent.focus(screen.getByRole('button', { name: 'Family changed' }))
  const popup = within(
    screen.getByRole('dialog', { name: 'Air Force: Family' })
  )
  const before = popup.getByRole('figure', { name: 'Army' })
  const after = popup.getByRole('figure', { name: 'Celebrating the Arts' })
  // The old template is outside the draft, so it comes from the catalog.
  expect(mocks.plateDetail).toHaveBeenCalledWith('AK.army')
  expect(within(before).getByRole('img').getAttribute('src')).toContain(
    'AK.army.webp'
  )
  expect(within(after).getByRole('img').getAttribute('src')).toContain(
    'AK.celebrating_the_arts.webp'
  )
  expect(
    within(after)
      .getByText('Celebrating the Arts')
      .compareDocumentPosition(within(after).getByRole('img')) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
})

test('filters narrow the list to one kind of change, and search narrows it further', () => {
  render(<DraftPublish draftId="shared-draft-test" />)
  fireEvent.click(screen.getByRole('button', { name: 'Moved 2' }))
  expect(screen.getByText('PWS')).toBeTruthy()
  expect(screen.getByText('Lions Club')).toBeTruthy()
  expect(screen.queryByText('Air Force')).toBeNull()
  expect(screen.queryByRole('region', { name: 'Alabama changes' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'All 5' }))
  fireEvent.change(
    screen.getByRole('searchbox', { name: 'Search changing plates' }),
    {
      target: { value: 'ag tag' },
    }
  )
  expect(screen.getByText('Ag Tag (Farming Feeds)')).toBeTruthy()
  expect(screen.queryByText('PWS')).toBeNull()
})

test('the side panel counts the changes, names who made them and ends with Publish', () => {
  render(<DraftPublish draftId="shared-draft-test" />)
  const panel = within(
    screen.getByRole('complementary', { name: 'Publish summary' })
  )
  expect(panel.getByText('edited').previousSibling?.textContent).toBe('4')
  expect(panel.getByText('moved').previousSibling?.textContent).toBe('2')
  expect(panel.getByText('removed').previousSibling?.textContent).toBe('0')
  expect(panel.getByText(/Dana · 2 plates/)).toBeTruthy()
  expect(panel.getByText(/Lee · 2 plates/)).toBeTruthy()
  const buttons = panel.getAllByRole('button')
  expect(buttons.at(-1)?.textContent).toContain('Publish revision 7')
})

test('clicking a plate opens its full before and after and puts the hover card away', () => {
  render(<DraftPublish draftId="shared-draft-test" />)
  const plate = screen.getByRole('button', { name: /^Lions Club/ })
  expect(plate.getAttribute('aria-expanded')).toBe('false')
  fireEvent.focus(plate)
  expect(
    screen.getByRole('dialog', { name: 'Lions Club: every change' })
  ).toBeTruthy()
  fireEvent.click(plate)
  expect(
    screen.queryByRole('dialog', { name: 'Lions Club: every change' })
  ).toBeNull()
  expect(plate.getAttribute('aria-expanded')).toBe('true')
  expect(
    document.getElementById(plate.getAttribute('aria-controls')!)?.textContent
  ).toContain('Before')
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
      'Catalog moved from v7 to v9 in a way the publish receipts cannot trace, so the draft stays on v7 until you review it.'
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

test('an untraceable span lists the put-backs the keep button keeps for the next Publish', async () => {
  mocks.view = view({
    canPublish: false,
    conflicts: [
      {
        kind: 'catalog',
        fromVersion: 1,
        toVersion: 23,
        resets: [{ plateId: 'AK.one', fields: { tags: [] } }],
        orderResets: { AL: ['AL.one', 'AL.two', 'AL.three'] },
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
      'Catalog moved from v1 to v23 in a way the publish receipts cannot trace, so the draft stays on v1 until you review it.'
    )
  ).toBeTruthy()
  const resets = within(
    alert.getByText(
      "The draft put these back after a revision that may have published. Keeping the draft's values keeps them, and the next Publish ships them:"
    ).parentElement!
  )
  expect(resets.getByText('AK.one')).toBeTruthy()
  expect(resets.getByText('Tags')).toBeTruthy()
  expect(resets.getByText('None')).toBeTruthy()
  expect(resets.getByText('AL plate order')).toBeTruthy()
  expect(resets.getByText('AL.one, AL.two, AL.three')).toBeTruthy()
  fireEvent.click(
    alert.getByRole('button', {
      name: "Keep the draft's values and keep the put-backs for the next Publish",
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
