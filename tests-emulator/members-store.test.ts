import { afterAll, beforeEach } from 'vitest'
import { firestoreMembersStore } from '../lib/members/firestore-store'
import { membersStoreScenarios } from '../tests/members/store-scenarios'
import { db } from './setup'

beforeEach(async () => { await db.recursiveDelete(db.collection('members')) })
afterAll(async () => {
  await db.recursiveDelete(db.collection('members'))
  await db.terminate()
})

membersStoreScenarios(async now => firestoreMembersStore(db, now))
