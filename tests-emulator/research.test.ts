import { Firestore } from '@google-cloud/firestore'
import { afterAll, expect, test } from 'vitest'
import { firestoreResearchStore } from '../lib/research/firestore-store'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { claimResearch, reportResearch } from '../lib/research/jobs'
import { acceptResearch } from '../lib/research/accept'
import { plateRevision } from '../lib/review/revision'
import { researchFixture } from '../tests/research/fixture'
import './setup'

const db = new Firestore({ projectId: 'demo-plate-curator-research' })
afterAll(() => db.terminate())

test('Firestore claim exclusivity, environment fencing and atomic Batch acceptance survive contention', async () => {
  for (const name of ['researchJobs', 'reviewBatches']) await db.recursiveDelete(db.collection(name))
  const f = researchFixture()
  const review = { ...f.review, store: firestoreReviewStore(db, 'development') }
  await review.store.create((await f.review.store.getBatch('batch'))!)
  const store = firestoreResearchStore(db, 'development')
  const deps = { ...f.deps, store, review }
  const job = await f.start()
  if (!job.ok) throw new Error('setup')
  await store.transaction(async tx => tx.set(job.value))
  const claims = await Promise.all(['a', 'b'].map(worker => claimResearch(deps, worker)))
  expect(claims.filter(Boolean)).toHaveLength(1)
  const index = claims[0] ? 0 : 1
  const claim = claims[index]!
  expect(await claimResearch({ ...deps, store: firestoreResearchStore(db, 'production') }, 'other')).toBeNull()
  await reportResearch(deps, ['a', 'b'][index], { jobId: claim.job.id, claimId: claim.claimId, result: f.result(claim.job) })
  // Empty results cannot clear existing fields, and no Batch write leaks through rejection.
  expect(await acceptResearch(deps, f.owner, { jobId: claim.job.id, baseRevision: plateRevision(f.plate), fields: ['funFacts'] })).toMatchObject({ ok: false, error: 'invalid_result' })
  expect((await review.store.getBatch('batch'))!.revision).toBe(0)
  await store.transaction(async tx => {
    const job = (await tx.get(claim.job.id))!
    tx.set({ ...job, result: { ...job.result!, draft: { ...job.result!.draft, description: 'The wildlife program supports habitat protection across Arizona through optional registration fees.', descriptionSources: ['S1'] }, sources: [{ id: 'S1', kind: 'web', title: 'Wildlife', url: 'https://example.com/wildlife', fetchedAt: '2026-11-17T00:00:00Z', contentHash: 'hash', text: 'The wildlife program supports habitat protection across Arizona through optional registration fees.' }] } })
  })
  const accepted = await acceptResearch(deps, f.owner, { jobId: claim.job.id, baseRevision: plateRevision(f.plate), fields: ['description'] })
  expect(accepted).toMatchObject({ ok: true, value: { batch: { revision: 1 } } })
  expect((await review.store.getEdit('batch', f.plate.id))?.fields.description).toContain('habitat protection')
  expect((await store.transaction(tx => tx.get(claim.job.id)))?.acceptedFields).toEqual(['description'])
}, 30000)

test('excluded records before the first hundred cannot starve a later desktop job', async () => {
  await db.recursiveDelete(db.collection('researchJobs'))
  const f = researchFixture()
  const started = await f.start()
  if (!started.ok) throw new Error('setup')
  const batch = db.batch()
  for (let index = 0; index < 105; index++) {
    const id = `a${String(index).padStart(3, '0')}`
    batch.set(db.doc(`researchJobs/${id}`), { ...started.value, id, deadline: 0 })
  }
  const eligible = { ...started.value, id: 'z-eligible' }
  batch.set(db.doc('researchJobs/z-eligible'), eligible)
  await batch.commit()
  expect(await claimResearch({ ...f.deps, store: firestoreResearchStore(db, 'development') }, 'desktop')).toMatchObject({ job: { id: 'z-eligible' } })
})
