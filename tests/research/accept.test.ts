import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { parseEditableFields } from '../../lib/review/fields'
import { plateRevision } from '../../lib/review/revision'
import { claimResearch, reportResearch } from '../../lib/research/jobs'
import { acceptResearch } from '../../lib/research/accept'
import { researchFixture } from './fixture'

async function completed() {
  const f = researchFixture()
  await f.start()
  const claim = (await claimResearch(f.deps, 'desktop'))!
  const text = 'The wildlife program began in 1987 and supports habitat protection across Arizona through optional registration fees.'
  const source = { id: 'S1', kind: 'web' as const, url: 'https://example.com/wildlife', title: 'Wildlife program', text, contentHash: createHash('sha256').update(text).digest('hex'), fetchedAt: '2026-11-17T00:00:00Z' }
  const result = { ...f.result(claim.job), sources: [source], draft: { description: 'The wildlife program supports habitat protection across Arizona through optional registration fees.', descriptionSources: ['S1'], funFacts: [{ text: 'The wildlife program began in 1987.', sourceId: 'S1' }], readMore: ['S1'], wikiSource: null } }
  const reported = await reportResearch(f.deps, 'desktop', { jobId: claim.job.id, claimId: claim.claimId, result })
  expect(reported).toMatchObject({ ok: true })
  return { ...f, job: claim.job }
}

test('research fields are validated and linked without accepting unsafe URL schemes', () => {
  expect(parseEditableFields({ funFacts: [{ text: 'A sourced fact', sourceUrl: 'https://example.com/fact' }], readMore: [{ title: 'Read more', site: 'example.com', url: 'https://example.com' }] })).toMatchObject({ funFacts: [{ text: 'A sourced fact' }], readMore: [{ title: 'Read more' }] })
  expect(parseEditableFields({ wikiUrl: 'javascript:alert(1)' })).toBeNull()
})

test('accepting only facts preserves unrelated fields and advances the Batch revision', async () => {
  const f = await completed()
  const result = await acceptResearch(f.deps, f.owner, { jobId: f.job.id, baseRevision: plateRevision(f.plate), fields: ['funFacts'] })
  expect(result).toMatchObject({ ok: true, value: { plate: { funFacts: [{ text: 'The wildlife program began in 1987.', sourceUrl: 'https://example.com/wildlife' }] }, batch: { state: 'open', revision: 1, approval: null } } })
  const edit = await f.review.store.getEdit('batch', f.plate.id)
  expect(Object.keys(edit!.fields)).toEqual(['funFacts'])
})

test('replaced runs and absent draft fields cannot overwrite the plate', async () => {
  const f = await completed()
  expect(await acceptResearch(f.deps, f.owner, { jobId: f.job.id, baseRevision: plateRevision(f.plate), fields: ['wikiUrl'] })).toMatchObject({ ok: false })
  await f.start('replacement', 'eve', f.job.id)
  expect(await acceptResearch(f.deps, f.owner, { jobId: f.job.id, baseRevision: plateRevision(f.plate), fields: ['description'] })).toMatchObject({ ok: false, error: 'superseded' })
  expect((await f.review.store.getBatch('batch'))!.revision).toBe(0)
})
