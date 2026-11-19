import { vi } from 'vitest'
import {
  firestorePublishControl,
  firestorePublishCurator,
  firestorePublishLock,
  firestorePublishPointer,
  firestorePublishRecords,
} from '../lib/publish/firestore'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { verifyPreparedObject } from '../lib/publish/snapshots/object'
import { batch, command, fixture } from '../tests/publish/fixture'
import type { PublishRunLookup } from '../lib/publish/eligibility'
import { db } from './setup'

export const env = 'release-controls'
export const now = '2026-11-15T12:00:00Z'
export const actor = command.requestedBy
export const collections = [
  'publishRecords',
  'publishVersionBurns',
  'publishCommands',
  'publishCommandStops',
  'releaseFences',
  'catalogPushes',
  'reviewBatches',
  'curatorLive',
  'members',
  'users',
]

/** Reset emulator release records and re-create the active owner for each scenario. */
export async function resetRelease() {
  for (const collection of collections)
    await db.recursiveDelete(db.collection(collection))
  await db.doc('locks/publish').delete()
  await db.doc('config/catalog').set({ version: 1 })
  await db
    .doc('config/publishControl')
    .set({ paused: false, generation: 1, changedBy: actor, changedAt: now })
  await db.doc('reviewBatches/batch').set({ ...batch, env })
  for (const [uid, email] of [
    ['owner', 'owner@example.com'],
    ['backup', 'backup@example.com'],
  ])
    await db
      .doc(`members/${encodeURIComponent(email)}`)
      .set({ uid, email, role: 'owner', status: 'active', authorityEpoch: 0 })
}

/** Remove the emulator release records and close the test Firestore connection. */
export async function cleanupRelease() {
  for (const collection of collections)
    await db.recursiveDelete(db.collection(collection))
  for (const path of [
    'locks/publish',
    'config/catalog',
    'config/publishControl',
    'curator/workflow',
  ])
    await db.doc(path).delete()
  await db.terminate()
}

/**
 * Build a release fixture that uses real Firestore coordination and controlled snapshot
 * and push dependencies.
 */
export function releaseFixture(
  lookup: PublishRunLookup = {
    /** Control discovery by command token when the fixture has no recorded workflow ID. */ findRun:
      async () => null,
    /** Provide controlled workflow status for the publish or queue recovery scenario. */ runStatus:
      async () => 'running',
  }
) {
  const f = fixture()
  const deps = {
    ...f.deps,
    /** Read the controlled test clock so state and lease timestamps advance deterministically. */ now: () =>
      now,
    store: firestoreReviewStore(db, env),
    control: firestorePublishControl(db),
    lock: firestorePublishLock(db, env),
    records: firestorePublishRecords(db, env, lookup),
    pointer: firestorePublishPointer(db, env, (receipt) =>
      verifyPreparedObject(f.deps.snapshots, receipt)
    ),
    curator: firestorePublishCurator(db, env),
  }
  const send = vi.fn(async (messages: unknown[]) =>
    messages.map(() => ({ status: 'ok' as const }))
  )
  return { ...f, deps, send }
}
