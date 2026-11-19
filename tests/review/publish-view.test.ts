import { expect, test } from 'vitest'
import { draftPublishSummary } from '../../lib/review/publish-view'
import type { ProposedEdit, ReviewBatch } from '../../lib/review/types'
import type { DraftChange } from '../../lib/review/checkpoint'

const draft: ReviewBatch = {
  id: 'shared-draft-test',
  kind: 'shared-draft',
  name: 'Shared draft',
  createdBy: 'system',
  createdByName: null,
  createdAt: '2026-11-18',
  state: 'open',
  revision: 4,
  baselineVersion: 11,
  plateIds: ['AK.one', 'AK.two', 'AL.one'],
  stateOrders: { AL: ['AL.two', 'AL.one', 'AL.three'] },
  baselineOrders: { AL: ['AL.one', 'AL.two', 'AL.three'] },
  approval: null,
}

/** Build a saved field edit by one curator. */
function edit(
  plateId: string,
  authorId: string,
  authorName?: string
): ProposedEdit {
  return {
    plateId,
    baseRevision: 'base',
    resultRevision: 'result',
    fields: { tags: ['new'] },
    authorId,
    ...(authorName ? { authorName } : {}),
    updatedAt: '2026-11-18T10:00:00Z',
  }
}

test('Publish summary counts changed and moved plates per state and names contributors', () => {
  const changes: DraftChange[] = [
    {
      revision: 3,
      plateIds: ['AK.one'],
      contributors: [{ uid: 'editor-uid', name: 'Editor' }],
      states: ['AK'],
    },
    {
      revision: 4,
      plateIds: [],
      contributors: [{ uid: 'owner-uid', name: 'Owner' }],
      states: ['AL'],
      orderStates: ['AL'],
    },
  ]
  expect(
    draftPublishSummary(
      {
        batch: draft,
        edits: [
          edit('AK.one', 'editor-uid'),
          edit('AK.two', 'pipeline', 'Plate Pipeline'),
          { ...edit('AL.one', 'owner-uid'), fields: {} },
        ],
      },
      changes
    )
  ).toEqual([
    {
      state: 'AK',
      plates: 2,
      moved: 0,
      contributors: ['Editor', 'Plate Pipeline'],
    },
    // Swapping two neighbours is one move.
    { state: 'AL', plates: 0, moved: 1, contributors: ['Owner'] },
  ])
})

test('an edit without a stored name falls back to its uid only when no change names it', () => {
  expect(
    draftPublishSummary(
      {
        batch: { ...draft, stateOrders: {}, baselineOrders: {} },
        edits: [edit('AK.one', 'ghost')],
      },
      []
    )
  ).toEqual([{ state: 'AK', plates: 1, moved: 0, contributors: ['ghost'] }])
})
