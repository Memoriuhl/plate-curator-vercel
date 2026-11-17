import { activationResult } from '../lib/members/member'
import type { Member } from '../lib/members/types'
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
    return { removed: Boolean(member.get('removedAt')), epoch: member.get('authorityEpoch'), status: member.get('status'), access: access.exists }
  }, { readOnly: true })
  expect(saved).toEqual({ removed: true, epoch: 2, status: 'removed', access: false })
})

test('last Owner rejection keeps the live grant', async () => {
  const store = firestoreMembersStore(db)
  await store.upsertSeed({ email: 'owner@example.com', uid: 'live-owner', role: 'owner', signIn: 'google', status: 'active', invite: null, invitedBy: null, createdAt: '' })
  const grant = db.doc('curatorLiveAccess/live-owner')
  await grant.set({ envs: { development: 'grant' } })
  expect(await store.removeGuarded('owner@example.com')).toBe('last_owner')
  expect((await grant.get()).exists).toBe(true)
})


test.each(['updateRole', 'updateRoleGuarded'] as const)('%s changes role and authority in one transaction', async method => {
  const store = firestoreMembersStore(db)
  const input = { email: 'one@example.com', uid: 'one', role: 'owner', signIn: 'google', status: 'active', invite: null, invitedBy: null, createdAt: '' } as const
  await store.upsertSeed(input)
  await store.upsertSeed({ ...input, email: 'two@example.com', uid: 'two' })
  const [result, observed] = await Promise.all([
    store[method](input.email, 'editor'),
    db.runTransaction(async tx => (await tx.get(db.doc('members/one%40example.com'))).data(), { readOnly: true }),
  ])
  expect(result).toBe('ok')
  expect(observed).toMatchObject(observed?.role === 'owner' ? { role: 'owner', authorityEpoch: 1 } : { role: 'editor', authorityEpoch: 2 })
  expect(await store.getByEmail(input.email)).toMatchObject({ role: 'editor', authorityEpoch: 2 })
})


test('a removed Owner tombstone is inert to legacy active and activation checks', async () => {
  const store = firestoreMembersStore(db)
  const owner = { email: 'one@example.com', uid: 'one', role: 'owner', signIn: 'google', status: 'active', invite: null, invitedBy: null, createdAt: '' } as const
  await store.upsertSeed(owner)
  await store.upsertSeed({ ...owner, email: 'two@example.com', uid: 'two' })
  expect(await store.removeGuarded(owner.email)).toBe('ok')
  const tombstone = (await db.doc('members/one%40example.com').get()).data() as Member
  expect(tombstone).toMatchObject({ role: 'owner', status: 'removed', uid: null, invite: null, authorityEpoch: 2 })
  expect(tombstone.role === 'owner' && tombstone.status === 'active').toBe(false)
  expect(activationResult(tombstone, '2026-11-16T12:00:00Z')).toBe('invalid_state')
})
