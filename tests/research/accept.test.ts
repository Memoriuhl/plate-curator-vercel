import { createHash } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { parseStoryFields } from '../../lib/review/fields'
import { buildPlate } from '../../lib/catalog/dashboard-build'
import { proposeEdit } from '../../lib/review/batch'
import { plateRevision } from '../../lib/review/revision'
import { claimResearch, reportResearch } from '../../lib/research/jobs'
import { acceptResearch } from '../../lib/research/accept'
import { researchFixture } from './fixture'
import { dispatchEveResearch, finishEveResearch } from '../../lib/research/hosted'
import { createResearchMemoryState } from '../../lib/research/state'

afterEach(() => vi.unstubAllEnvs())

async function completed(sourceOverrides: { title?: string; url?: string } = {}, executor: 'desktop' | 'eve' = 'desktop') {
  const f = researchFixture()
  const started = await f.start('request', executor)
  if (!started.ok) throw new Error('start failed')
  const claim = executor === 'desktop' ? (await claimResearch(f.deps, 'desktop'))! : null
  const job = claim?.job ?? (await dispatchEveResearch(f.deps, started.value.id, async () => ({ sessionId: 'session', deliveryId: 'delivery' })))!
  const text = 'The wildlife program began in 1987 and supports habitat protection across Arizona through optional registration fees.'
  const source = { id: 'S1', kind: 'web' as const, url: 'https://example.com/wildlife', title: 'Wildlife program', text, contentHash: createHash('sha256').update(text).digest('hex'), fetchedAt: '2026-11-17T00:00:00Z', ...sourceOverrides }
  const result = { ...f.result(job), sources: [source], draft: { description: 'The wildlife program supports habitat protection across Arizona through optional registration fees.', descriptionSources: ['S1'], funFacts: [{ text: 'The wildlife program began in 1987.', sourceId: 'S1' }], readMore: ['S1'], wikiSource: null } }
  if (claim) {
    expect(await reportResearch(f.deps, 'desktop', { jobId: job.id, claimId: claim.claimId, result })).toMatchObject({ ok: true })
  } else {
    const state = createResearchMemoryState()
    await state.update(`draft/${job.id}`, () => ({ value: { draft: result.draft, sources: result.sources, rejected: [] }, result: null }))
    await state.update(`eve-outcome/${job.id}`, () => ({ value: { outcome: 'success' }, result: null }))
    expect(await finishEveResearch(f.deps, job.id, state)).toMatchObject({ state: 'completed' })
  }
  return { ...f, job }
}

test('research fields are validated and linked without accepting unsafe URL schemes', () => {
  expect(parseStoryFields({ funFacts: [{ text: 'A sourced fact', sourceUrl: 'https://example.com/fact' }], readMore: [{ title: 'Read more', site: 'example.com', url: 'https://example.com' }] })).toMatchObject({ funFacts: [{ text: 'A sourced fact' }], readMore: [{ title: 'Read more' }] })
  expect(parseStoryFields({ wikiUrl: 'javascript:alert(1)' })).toBeNull()
})

test('hosted acceptance stores and exposes story fields with local editing disabled', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  const f = await completed({}, 'eve')
  const result = await acceptResearch(f.deps, f.owner, { jobId: f.job.id, baseRevision: plateRevision(f.plate), fields: ['description', 'funFacts', 'readMore'] })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('acceptance failed')
  const fields = (await f.review.store.getEdit('batch', f.plate.id))!.fields
  expect(fields).toMatchObject({ funFacts: [{ text: 'The wildlife program began in 1987.' }], readMore: [{ site: 'example.com' }] })
  const detail = buildPlate({ version: 14, plates: [result.value.plate] }, { stateOrder: {}, stateProgress: {} }, () => null, f.plate.id)
  expect(detail!.plate).toMatchObject({ funFacts: [{ text: 'The wildlife program began in 1987.' }], readMore: [{ url: 'https://example.com/wildlife' }] })
})

test.each(['sourceUrl', 'firstIssuedYear', 'tags'])('research acceptance cannot expand into %s', async field => {
  const f = await completed()
  expect(await acceptResearch(f.deps, f.owner, { jobId: f.job.id, baseRevision: plateRevision(f.plate), fields: [field] })).toEqual({ ok: false, error: 'invalid_result' })
  expect(await f.review.store.getEdit('batch', f.plate.id)).toBeNull()
})

test('accepting only facts preserves unrelated fields and advances the Batch revision', async () => {
  const f = await completed()
  const result = await acceptResearch(f.deps, f.owner, { jobId: f.job.id, baseRevision: plateRevision(f.plate), fields: ['funFacts'] })
  expect(result).toMatchObject({ ok: true, value: { plate: { funFacts: [{ text: 'The wildlife program began in 1987.', sourceUrl: 'https://example.com/wildlife' }] }, batch: { state: 'open', revision: 1, approval: null } } })
  const edit = await f.review.store.getEdit('batch', f.plate.id)
  expect(Object.keys(edit!.fields)).toEqual(['funFacts'])
})

test('acceptance bounds citation titles without changing captured evidence or URLs', async () => {
  const f = await completed({ title: 'A'.repeat(250) })
  const result = await acceptResearch(f.deps, f.owner, { jobId: f.job.id, baseRevision: plateRevision(f.plate), fields: ['funFacts', 'readMore'] })
  expect(result).toMatchObject({ ok: true, value: { plate: {
    funFacts: [{ sourceTitle: 'A'.repeat(200), sourceUrl: 'https://example.com/wildlife' }],
    readMore: [{ title: 'A'.repeat(200), site: 'example.com', url: 'https://example.com/wildlife' }],
    sourceUrl: 'https://example.com/image',
  } } })
  const saved = await f.store.transaction(tx => tx.get(f.job.id))
  expect(saved!.result!.sources[0].title).toHaveLength(250)
})

test('acceptance bounds a long site label while retaining its full citation URL', async () => {
  const url = `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(20)}/wildlife`
  const f = await completed({ url })
  const result = await acceptResearch(f.deps, f.owner, { jobId: f.job.id, baseRevision: plateRevision(f.plate), fields: ['readMore'] })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('acceptance failed')
  expect(result.value.plate.readMore![0].site).toHaveLength(200)
  expect(result.value.plate.readMore![0].url).toBe(url)
})

test('acceptance uses the hostname when the captured page title is blank', async () => {
  const f = await completed({ title: '   ' })
  expect(await acceptResearch(f.deps, f.owner, { jobId: f.job.id, baseRevision: plateRevision(f.plate), fields: ['funFacts', 'readMore'] })).toMatchObject({ ok: true, value: { plate: {
    funFacts: [{ sourceTitle: 'example.com' }],
    readMore: [{ title: 'example.com', site: 'example.com' }],
  } } })
})

test('replaced runs and absent draft fields cannot overwrite the plate', async () => {
  const f = await completed()
  expect(await acceptResearch(f.deps, f.owner, { jobId: f.job.id, baseRevision: plateRevision(f.plate), fields: ['wikiUrl'] })).toMatchObject({ ok: false })
  await f.start('replacement', 'eve', f.job.id)
  expect(await acceptResearch(f.deps, f.owner, { jobId: f.job.id, baseRevision: plateRevision(f.plate), fields: ['description'] })).toMatchObject({ ok: false, error: 'superseded' })
  expect((await f.review.store.getBatch('batch'))!.revision).toBe(0)
})

test('links-only acceptance preserves image provenance and facts, and own acceptance allows remaining fields', async () => {
  const f = await completed()
  const first = await acceptResearch(f.deps, f.owner, { jobId: f.job.id, baseRevision: plateRevision(f.plate), fields: ['readMore'] })
  expect(first).toMatchObject({ ok: true, value: { plate: { image: 'one.webp', sourceUrl: 'https://example.com/image', funFacts: [{ text: 'Existing curator fact' }] } } })
  if (!first.ok) throw new Error('setup')
  expect(await acceptResearch(f.deps, f.owner, { jobId: f.job.id, baseRevision: plateRevision(first.value.plate), fields: ['description'] })).toMatchObject({ ok: true, value: { plate: { readMore: [{ url: 'https://example.com/wildlife' }] } } })
})

test('an intervening edit makes the completed draft inspectable but unacceptable', async () => {
  const f = await completed()
  await proposeEdit(f.review, f.owner, { batchId: 'batch', plateId: f.plate.id, baseRevision: plateRevision(f.plate), fields: { tags: ['changed'] } })
  const current = { ...f.plate, tags: ['changed'] }
  expect(await acceptResearch(f.deps, f.owner, { jobId: f.job.id, baseRevision: plateRevision(current), fields: ['description'] })).toMatchObject({ ok: false, error: 'stale_input' })
})
