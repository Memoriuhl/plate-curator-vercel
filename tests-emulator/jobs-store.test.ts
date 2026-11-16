import { afterAll } from 'vitest'
import { jobsScenarios } from '../tests/jobs/scenarios'
import { firestoreJobsStore } from '../lib/jobs/firestore-store'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { Firestore } from '@google-cloud/firestore'
import './setup'

const db = new Firestore({ projectId: 'demo-plate-curator-jobs' })

jobsScenarios(async () => {
  await db.recursiveDelete(db.collection('jobs'))
  await db.recursiveDelete(db.collection('workerTokens'))
  await db.recursiveDelete(db.collection('reviewBatches'))
  return { store: firestoreJobsStore(db, 'development'), other: firestoreJobsStore(db, 'production'), review: firestoreReviewStore(db, 'development') }
})

afterAll(async () => {
  await db.recursiveDelete(db.collection('jobs'))
  await db.recursiveDelete(db.collection('workerTokens'))
  await db.recursiveDelete(db.collection('reviewBatches'))
  await db.terminate()
})
