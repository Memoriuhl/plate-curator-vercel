import { expect, test } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import {
  ensureDraft,
  freezeRelease,
  releaseId,
} from '../../lib/review/draft/draft'
import { sharedDraftId } from '../../lib/review/draft/draft-id'
import { createMemoryStore } from '../../lib/review/memory-store'
import { plateRevision } from '../../lib/review/draft/revision'
import type { ReviewDeps } from '../../lib/review/types'
import { sharedDraftScenarios } from './draft-scenarios'

sharedDraftScenarios(() => createMemoryStore([]))

test('a draft too large for one Firestore write refuses to freeze with a clear reason and writes nothing', async () => {
  const plates: Plate[] = Array.from({ length: 40 }, (_, i) => ({
    id: `AK.${i}`,
    state: 'AK',
    slug: `${i}`,
    displayName: `${i}`,
    image: '',
    tags: [],
  }))
  const store = createMemoryStore([])
  const find = async (id: string) => plates.find((p) => p.id === id) ?? null
  const d: ReviewDeps = {
    store,
    baseline: find,
    baselineAtVersion: async (_version, id) => find(id),
    stateBaseline: async () => plates,
    liveVersion: async () => 1,
    now: () => '2026-11-18T12:00:00.000Z',
  }
  const env = 'budget'
  const draftId = sharedDraftId(env)
  const owner = { uid: 'owner', name: 'Owner' }
  const draft = await ensureDraft(d, env, owner)
  // 40 descriptions of 256 KiB: 10 MiB of values, past the one-write budget. The
  // per-field limits keep curators below this, so the edits are seeded directly.
  const description = 'x'.repeat(256 * 1024)
  expect(
    await store.commit(draftId, draft.revision, {
      batch: {
        ...draft,
        plateIds: plates.map((p) => p.id),
        revision: draft.revision + 1,
      },
      edits: plates.map((p) => ({
        plateId: p.id,
        fields: { description },
        authorId: 'owner',
        updatedAt: '2026-11-18T12:00:00.000Z',
        baseRevision: plateRevision(p),
        resultRevision: plateRevision({ ...p, description }),
      })),
      history: false,
    })
  ).toBe('ok')
  expect(await freezeRelease(d, env, owner, draft.revision + 1)).toEqual({
    ok: false,
    error: 'draft_too_large',
  })
  expect(
    await store.getBatch(
      releaseId(env, draftId, draft.baselineVersion, draft.revision + 1)
    )
  ).toBeNull()
})
