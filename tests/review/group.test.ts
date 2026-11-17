import { afterEach, expect, test, vi } from 'vitest'
import { createMemoryStore } from '../../lib/review/memory-store'
import { acceptGroup, completeGroupScope } from '../../lib/review/group'
import { plateRevision } from '../../lib/review/revision'
import type { Plate } from '../../lib/catalog/types'
import type { ReviewDeps } from '../../lib/review/types'
import type { GroupSuggestion } from '../../lib/jobs/specialized-suggestions'

afterEach(() => vi.unstubAllEnvs())
const actor = { uid: 'editor', name: null, role: 'editor' as const }
function setup() {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const plates: Plate[] = ['a', 'b', 'c'].map((id, i) => ({ id: `AK.${id}`, state: 'AK', slug: id, displayName: id, tags: [], image: `${id}.webp`, templateFamily: `old-${id}`, templateRole: 'template', isStandard: i === 0 }))
  const store = createMemoryStore([{ id: 'batch', name: 'Group', createdBy: actor.uid, createdAt: '', revision: 0, baselineVersion: 1, state: 'open', approval: null, plateIds: ['AK.a'], stateOrders: { AK: plates.map(plate => plate.id) } }])
  const d: ReviewDeps = { store, baseline: async id => plates.find(plate => plate.id === id) ?? null, baselineAtVersion: async (_, id) => plates.find(plate => plate.id === id) ?? null, stateBaseline: async () => plates, now: () => '' }
  const suggestion: GroupSuggestion = { kind: 'group', stage: 'group', sources: [], scope: plates.slice(0, 2).map(plate => ({ plateId: plate.id, baseRevision: plateRevision(plate) })), proposals: plates.slice(0, 2).map((plate, i) => ({ plateId: plate.id, baseRevision: plateRevision(plate), fields: { templateFamily: 'AK.a', templateRole: i === 0 ? 'template' : 'variant', variantOfPlateId: i === 0 ? null : 'AK.a' } })) }
  return { d, store, plates, suggestion }
}

test('applies all group members in one Batch revision and preserves unrelated data, order and Standard', async () => {
  const s = setup()
  expect(await s.store.listEdits('batch')).toEqual([])
  expect(await acceptGroup(s.d, actor, { batchId: 'batch', batchRevision: 0, suggestion: s.suggestion })).toMatchObject({ ok: true, value: { revision: 1, stateOrders: { AK: ['AK.a', 'AK.b', 'AK.c'] } } })
  const edits = await s.store.listEdits('batch')
  expect(edits).toHaveLength(2)
  expect(edits.find(edit => edit.plateId === 'AK.b')?.fields).toMatchObject({ templateFamily: 'AK.a', templateRole: 'variant', variantOfPlateId: 'AK.a' })
  expect(s.plates[1].templateFamily).toBe('old-b')
  expect(edits.every(edit => edit.fields.isStandard === undefined)).toBe(true)
  expect(await acceptGroup(s.d, actor, { batchId: 'batch', batchRevision: 0, suggestion: s.suggestion })).toMatchObject({ error: 'superseded_revision' })
})

test('rejects stale peers, partial families and invalid Standard proposals without partial writes', async () => {
  const s = setup()
  s.plates[1].description = 'Changed peer'
  expect(await acceptGroup(s.d, actor, { batchId: 'batch', batchRevision: 0, suggestion: s.suggestion })).toMatchObject({ error: 'stale_plate' })
  expect(await s.store.listEdits('batch')).toEqual([])
  delete s.plates[1].description
  s.plates[2].templateFamily = s.plates[1].templateFamily
  expect(completeGroupScope(s.plates.slice(0, 2), s.plates)).toBe(false)
  expect(await acceptGroup(s.d, actor, { batchId: 'batch', batchRevision: 0, suggestion: s.suggestion })).toMatchObject({ error: 'invalid_state' })
  s.plates[2].templateFamily = 'old-c'
  const swapped: GroupSuggestion = { ...s.suggestion, proposals: s.suggestion.proposals.map((value, i) => ({ ...value, fields: { templateFamily: 'AK.b', templateRole: i === 1 ? 'template' : 'variant', variantOfPlateId: i === 1 ? null : 'AK.b' } })) }
  expect(await acceptGroup(s.d, actor, { batchId: 'batch', batchRevision: 0, suggestion: swapped })).toMatchObject({ error: 'invalid_state' })
  expect(await s.store.listEdits('batch')).toEqual([])
})

test('authorization, flag and CAS failure cannot create partial edits', async () => {
  const s = setup()
  expect(await acceptGroup(s.d, { ...actor, uid: 'other' }, { batchId: 'batch', batchRevision: 0, suggestion: s.suggestion })).toMatchObject({ error: 'forbidden' })
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  expect(await acceptGroup(s.d, actor, { batchId: 'batch', batchRevision: 0, suggestion: s.suggestion })).toMatchObject({ error: 'forbidden' })
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  s.store.commit = async () => 'revision_mismatch'
  expect(await acceptGroup(s.d, actor, { batchId: 'batch', batchRevision: 0, suggestion: s.suggestion })).toMatchObject({ error: 'superseded_revision' })
  expect(await s.store.listEdits('batch')).toEqual([])
})
