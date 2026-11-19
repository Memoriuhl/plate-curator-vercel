import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { firestoreMigrationBlock } from '../lib/review/migration-gate'
import { sharedDraftScenarios } from '../tests/review/draft-scenarios'
import { migrationScenarios } from '../tests/review/migrate-scenarios'
import { db } from './setup'

migrationScenarios((env) => firestoreReviewStore(db, env), 30_000)
sharedDraftScenarios((env) => firestoreReviewStore(db, env), 30_000)

const lock = db.doc('locks/publish')
let savedLock: FirebaseFirestore.DocumentData | undefined
beforeEach(async () => {
  savedLock = (await lock.get()).data()
  await lock.delete()
})
afterEach(async () => {
  if (savedLock) await lock.set(savedLock)
  else await lock.delete()
})

test('the migration waits for a live publish lock in its own environment only', async () => {
  const env = `migrate-${randomUUID().slice(0, 8)}`
  const now = Date.parse('2026-11-18T12:00:00Z')
  await lock.set({
    env,
    purpose: 'publish',
    expiresAt: '2026-11-18T12:05:00Z',
  })
  expect(await firestoreMigrationBlock(db, env, () => now)).toBe(
    'publish_locked'
  )
  expect(await firestoreMigrationBlock(db, 'other-env', () => now)).toBeNull()
  // An expired lock no longer holds the environment.
  expect(
    await firestoreMigrationBlock(db, env, () => now + 10 * 60_000)
  ).toBeNull()
})

test('the migration waits while a pipeline run on one of its Batches is queued or running', async () => {
  const env = `migrate-${randomUUID().slice(0, 8)}`
  const batchId = `${env}-batch`
  const run = db.doc(`localPipelineRuns/${env}-run`)
  await db.doc(`reviewBatches/${batchId}`).set({ env, state: 'open' })
  await run.set({ batchId, status: 'running' })
  try {
    expect(await firestoreMigrationBlock(db, env)).toBe('pipeline_busy')
    await run.update({ status: 'completed' })
    expect(await firestoreMigrationBlock(db, env)).toBeNull()
  } finally {
    await run.delete()
    await db.doc(`reviewBatches/${batchId}`).delete()
  }
})
