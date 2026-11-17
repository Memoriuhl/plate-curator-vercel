import { afterEach, expect, test, vi } from 'vitest'
import { parseEditableFields } from '../../lib/review/fields'
import { proposeEdit } from '../../lib/review/batch'
import { createMemoryStore } from '../../lib/review/memory-store'
import { plateRevision } from '../../lib/review/revision'
import { changeSummary, groupChanges } from '../../components/review/diff'
import type { Plate } from '../../lib/catalog/types'
import type { ReviewDeps } from '../../lib/review/types'

afterEach(() => vi.unstubAllEnvs())

const story = {
  firstIssuedYear: 1976,
  funFacts: [{ text: 'A sourced fact.', sourceUrl: 'https://en.wikipedia.org/wiki/Vehicle_registration_plate', sourceTitle: 'Registration plate' }],
  wikiUrl: 'https://en.wikipedia.org/wiki/Vehicle_registration_plate',
  readMore: [{ title: 'Learn more', site: 'Example', url: 'https://example.org/plate' }],
}

test('story fields require exact local opt-in', () => {
  for (const flag of [undefined, '0', 'true']) {
    vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', flag)
    for (const [key, value] of Object.entries(story)) expect(parseEditableFields({ [key]: value })).toBeNull()
  }
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  expect(parseEditableFields(story)).toEqual(story)
})

test('supports explicit clearing and trims sourced text', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const cleared = { firstIssuedYear: null, funFacts: [], readMore: [], wikiUrl: null }
  expect(parseEditableFields(cleared)).toEqual(cleared)
  expect(parseEditableFields({ funFacts: [{ text: ' Fact ', sourceUrl: ' https://example.org/fact ' }] })).toEqual({ funFacts: [{ text: 'Fact', sourceUrl: 'https://example.org/fact' }] })
})

test.each([
  { firstIssuedYear: 1799 }, { firstIssuedYear: 2101 }, { firstIssuedYear: 2000.5 }, { firstIssuedYear: '2000' },
  { funFacts: [{ text: 'Uncited' }] }, { funFacts: [{ text: '', sourceUrl: 'https://example.org' }] },
  { funFacts: [{ text: 'Fact', sourceUrl: 'javascript:alert(1)' }] },
  { funFacts: [{ text: 'Fact', sourceUrl: 'https://example.org', extra: true }] },
  { funFacts: Array.from({ length: 5 }, () => story.funFacts[0]) },
  { readMore: [{ title: 'Link', url: 'https://example.org' }] },
  { readMore: [{ title: 'Link', site: 'Example', url: '/relative' }] },
  { readMore: Array.from({ length: 9 }, () => story.readMore[0]) },
  { wikiUrl: 'https://user:password@example.org' }, { sourceUrl: 'file:///secret' },
  { sourceUrl: 'https://example.org/' + 'a'.repeat(2048) },
])('rejects invalid story input %j', input => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  expect(parseEditableFields(input)).toBeNull()
})

test('story edits persist for review, remain when the flag is off, and can be removed', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const plate: Plate = { id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', tags: [], image: '' }
  const actor = { uid: 'story-editor', name: null, role: 'editor' as const }
  const store = createMemoryStore([{ id: 'story-batch', name: 'Story', baselineVersion: 1, plateIds: [plate.id], revision: 0, approval: null, state: 'open', createdAt: '2026-11-17', createdBy: actor.uid }])
  const deps: ReviewDeps = { store, baseline: async () => plate, baselineAtVersion: async () => plate, stateBaseline: async () => [plate], now: () => '2026-11-17' }
  const request = { batchId: 'story-batch', plateId: plate.id, baseRevision: plateRevision(plate), fields: story }
  const result = await proposeEdit(deps, actor, request)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect((await store.getEdit(request.batchId, plate.id))?.fields).toEqual(story)
  expect(changeSummary(plate, result.value.plate, undefined, 'Edited')).toContain('funFacts')
  expect(groupChanges([{ baseline: plate, proposed: result.value.plate, revision: '1', edit: null }]).Edited).toHaveLength(1)
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  expect(changeSummary(plate, result.value.plate, undefined, 'Edited')).toContain('funFacts')
  expect(groupChanges([{ baseline: plate, proposed: result.value.plate, revision: '1', edit: null }]).Edited).toHaveLength(1)
  const updated = await proposeEdit(deps, actor, { ...request, baseRevision: plateRevision(result.value.plate), fields: { tags: ['changed'] } })
  expect(updated.ok).toBe(true)
  expect((await store.getEdit(request.batchId, plate.id))?.fields).toMatchObject(story)
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  if (!updated.ok) return
  const removed = await proposeEdit(deps, actor, { ...request, baseRevision: plateRevision(updated.value.plate), fields: { firstIssuedYear: null, wikiUrl: null, funFacts: [], readMore: [], tags: [] } })
  expect(removed.ok).toBe(true)
  expect(await store.getEdit(request.batchId, plate.id)).toBeNull()
})

test('server treats missing story fields and empty draft values as the same no-edit state', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const plate: Plate = { id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', tags: [], image: '' }
  const actor = { uid: 'story-editor', name: null, role: 'editor' as const }
  const store = createMemoryStore([{ id: 'empty-story', name: 'Story', baselineVersion: 1, plateIds: [plate.id], revision: 0, approval: null, state: 'open', createdAt: '2026-11-17', createdBy: actor.uid }])
  const deps: ReviewDeps = { store, baseline: async () => plate, baselineAtVersion: async () => plate, stateBaseline: async () => [plate], now: () => '2026-11-17' }
  expect(await proposeEdit(deps, actor, { batchId: 'empty-story', plateId: plate.id, baseRevision: plateRevision(plate), fields: { firstIssuedYear: null, wikiUrl: null, funFacts: [], readMore: [] } })).toMatchObject({ ok: true })
  expect(await store.listEdits('empty-story')).toEqual([])
})

test('story edits preserve the image provenance URL and cannot request its replacement', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const plate: Plate = { id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', tags: [], image: '', sourceUrl: 'https://example.org/original-image' }
  const actor = { uid: 'story-editor', name: null, role: 'editor' as const }
  const store = createMemoryStore([{ id: 'provenance', name: 'Story', baselineVersion: 1, plateIds: [plate.id], revision: 0, approval: null, state: 'open', createdAt: '', createdBy: actor.uid }])
  const deps: ReviewDeps = { store, baseline: async () => plate, baselineAtVersion: async () => plate, stateBaseline: async () => [plate], now: () => '' }
  expect(parseEditableFields({ sourceUrl: 'https://example.org/story-link' })).toBeNull()
  const result = await proposeEdit(deps, actor, { batchId: 'provenance', plateId: plate.id, baseRevision: plateRevision(plate), fields: story })
  expect(result).toMatchObject({ ok: true, value: { plate: { sourceUrl: plate.sourceUrl } } })
  expect((await store.getEdit('provenance', plate.id))?.fields).not.toHaveProperty('sourceUrl')
  expect((await store.getEdit('provenance', plate.id))?.fields.funFacts?.[0].sourceUrl).toBe(story.funFacts[0].sourceUrl)
})
