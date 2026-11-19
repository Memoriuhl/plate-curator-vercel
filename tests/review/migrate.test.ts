import { expect, test } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import { sharedDraftId } from '../../lib/review/draft/draft-id'
import { createMemoryStore } from '../../lib/review/memory-store'
import { migrateToSharedDraft } from '../../lib/review/migration/migrate'
import type { ReviewDeps } from '../../lib/review/types'
import { migrationScenarios } from './migrate-scenarios'

migrationScenarios(() => createMemoryStore([]))

test('a fold too large for one write is refused on the dry run and on apply before any Batch closes', async () => {
  const plates: Plate[] = Array.from({ length: 40 }, (_, i) => ({
    id: `AK.${i}`,
    state: 'AK',
    slug: `${i}`,
    displayName: `${i}`,
    image: '',
    tags: [],
  }))
  // 40 descriptions of 256 KiB: 10 MiB of values, past the one-write budget.
  const description = 'x'.repeat(256 * 1024)
  const store = createMemoryStore([])
  expect(
    await store.create(
      {
        id: 'ana',
        name: "Ana's Batch",
        createdBy: 'ana',
        createdByName: 'Ana',
        createdAt: '2026-11-17T10:00:00.000Z',
        lastChangedAt: '2026-11-17T10:00:00.000Z',
        state: 'open',
        revision: 1,
        baselineVersion: 1,
        approval: null,
        plateIds: plates.map((p) => p.id),
        stateOrders: {},
      },
      plates.map((p) => ({
        plateId: p.id,
        fields: { description },
        authorId: 'ana',
        updatedAt: '2026-11-17T10:00:00.000Z',
        baseRevision: 'legacy-base',
        resultRevision: 'legacy-result',
      }))
    )
  ).toBe('ok')
  const find = async (id: string) => plates.find((p) => p.id === id) ?? null
  const d: ReviewDeps = {
    store,
    baseline: find,
    baselineAtVersion: async (_version, id) => find(id),
    stateBaseline: async () => plates,
    liveVersion: async () => 1,
    now: () => '2026-11-18T12:00:00.000Z',
  }
  const actor = { uid: 'migration', name: 'Shared draft migration' }
  const tooLarge = {
    applied: false,
    refused: 'draft_too_large',
    warnings: [expect.stringContaining('too large to write in one request')],
  }
  expect(
    await migrateToSharedDraft(d, 'budget', { apply: false, actor })
  ).toMatchObject(tooLarge)
  expect(
    await migrateToSharedDraft(d, 'budget', { apply: true, actor })
  ).toMatchObject(tooLarge)
  // Nothing closed: the Batch keeps its edits and the draft holds none of them.
  expect(await store.getBatch('ana')).toMatchObject({ state: 'open' })
  expect((await store.readBatch(sharedDraftId('budget')))?.edits ?? []).toEqual(
    []
  )
})
