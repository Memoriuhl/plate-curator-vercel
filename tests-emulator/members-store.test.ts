import { afterAll, beforeEach, expect, test } from 'vitest'
import { firestoreMembersStore } from '../lib/members/firestore-store'
import { membersStoreScenarios } from '../tests/members/store-scenarios'
import { db } from './setup'

beforeEach(async () => {
  await db.recursiveDelete(db.collection('members'))
  await db.recursiveDelete(db.collection('curatorLiveAccess'))
})
afterAll(async () => {
  await db.recursiveDelete(db.collection('members'))
  await db.recursiveDelete(db.collection('curatorLiveAccess'))
  await db.terminate()
})

membersStoreScenarios(async now => firestoreMembersStore(db, now))


test.each(['remove', 'removeGuarded'] as const)('%s revokes a bound member grant together with membership', async method => {
  const store = firestoreMembersStore(db)
  await store.upsertSeed({ email: 'member@example.com', uid: 'live-member', role: 'editor', signIn: 'google', status: 'active', invite: null, invitedBy: null, createdAt: '' })
  const grant = db.doc('curatorLiveAccess/live-member')
  await grant.set({ envs: { development: 'grant' } })
  expect(await store[method]('member@example.com')).toBe('ok')
  const saved = await db.runTransaction(async tx => {
    const member = await tx.get(db.doc('members/member%40example.com'))
    const access = await tx.get(grant)
    return { member: member.exists, access: access.exists }
  }, { readOnly: true })
  expect(saved).toEqual({ member: false, access: false })
})

test('last Owner rejection keeps the live grant', async () => {
  const store = firestoreMembersStore(db)
  await store.upsertSeed({ email: 'owner@example.com', uid: 'live-owner', role: 'owner', signIn: 'google', status: 'active', invite: null, invitedBy: null, createdAt: '' })
  const grant = db.doc('curatorLiveAccess/live-owner')
  await grant.set({ envs: { development: 'grant' } })
  expect(await store.removeGuarded('owner@example.com')).toBe('last_owner')
  expect((await grant.get()).exists).toBe(true)
})
