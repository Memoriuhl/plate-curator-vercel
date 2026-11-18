import { afterAll } from 'vitest'
import { firestoreJobsStore } from '../lib/jobs/firestore-store'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { batchBaselineScenarios } from '../tests/review/baseline-scenarios'
import { db } from './setup'

/** Clear review batches and jobs before testing that reads use the pinned baseline. */
async function clear() {
  await db.recursiveDelete(db.collection('reviewBatches'))
  await db.recursiveDelete(db.collection('curatorLive'))
  await db.recursiveDelete(db.collection('jobs'))
}

batchBaselineScenarios(async () => {
  await clear()
  return { review: firestoreReviewStore(db, 'development'), jobs: firestoreJobsStore(db, 'development') }
}, 20000)

afterAll(async () => {
  await clear()
  await db.terminate()
})
