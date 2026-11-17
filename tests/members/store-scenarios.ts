import { expect, it } from 'vitest'
import { createInvite } from '../../lib/members/invite'
import type { MembersStore, PendingMember } from '../../lib/members/types'

export const instant = '2026-11-16T12:00:00.000Z'
const invite = createInvite('first-token', () => instant)
const pending: PendingMember = { email: ' Person@Example.com ', role: 'editor', signIn: 'google', invitedBy: 'owner', invite }

export function membersStoreScenarios(setup: (now: () => string) => Promise<MembersStore>) {
  it('increments authority across demotion, restore, removal and recreation', async () => {
    const store = await setup(() => instant)
    await store.create({ ...pending, role: 'owner' })
    await store.activate(pending.email, 'requester')
    const original = (await store.getByEmail(pending.email))!.authorityEpoch!
    expect(Number.isSafeInteger(original)).toBe(true)
    await store.updateRole(pending.email, 'editor')
    expect(await store.getByEmail(pending.email)).toMatchObject({ role: 'editor', authorityEpoch: original + 1 })
    await store.updateRole(pending.email, 'owner')
    expect(await store.getByEmail(pending.email)).toMatchObject({ role: 'owner', authorityEpoch: original + 2 })
    await store.remove(pending.email)
    expect(await store.getByEmail(pending.email)).toBeNull()
    await store.create({ ...pending, role: 'owner' })
    await store.activate(pending.email, 'requester')
    expect((await store.getByEmail(pending.email))!.authorityEpoch).toBeGreaterThan(original + 3)
  })

  it('guards the last active Owner and ignores pending Owners', async () => {
    const store = await setup(() => instant)
    await store.create({ ...pending, email: 'owner@example.com', role: 'owner' })
    await store.activate('owner@example.com', 'owner-uid')
    await store.create({ ...pending, email: 'invited@example.com', role: 'owner' })
    expect(await store.updateRoleGuarded('owner@example.com', 'editor')).toBe('last_owner')
    expect(await store.removeGuarded('owner@example.com')).toBe('last_owner')
    expect(await store.updateRoleGuarded('owner@example.com', 'owner')).toBe('ok')
    expect(await store.updateRoleGuarded('invited@example.com', 'editor')).toBe('ok')
    expect(await store.removeGuarded('invited@example.com')).toBe('ok')
    await store.create({ ...pending, email: 'second@example.com', role: 'owner' })
    await store.activate('second@example.com', 'second-uid')
    expect(await store.updateRoleGuarded('owner@example.com', 'editor')).toBe('ok')
    expect(await store.getByEmail('owner@example.com')).toMatchObject({ role: 'editor' })
    expect(await store.removeGuarded('owner@example.com')).toBe('ok')
    expect(await store.removeGuarded('owner@example.com')).toBe('not_found')
    expect(await store.updateRoleGuarded('missing@example.com', 'owner')).toBe('not_found')
    expect(await store.removeGuarded('second@example.com')).toBe('last_owner')
  })

  it('concurrent demotion and removal cannot eliminate both active Owners', async () => {
    const store = await setup(() => instant)
    await store.create({ ...pending, email: 'one@example.com', role: 'owner' })
    await store.create({ ...pending, email: 'two@example.com', role: 'owner' })
    await store.activate('one@example.com', 'one-uid')
    await store.activate('two@example.com', 'two-uid')
    const results = await Promise.all([store.updateRoleGuarded('one@example.com', 'editor'), store.removeGuarded('two@example.com')])
    expect(results.sort()).toEqual(['last_owner', 'ok'])
    expect((await store.list()).filter(member => member.role === 'owner')).toHaveLength(1)
  }, 20000)

  it('looks up invite hashes and forgets them after reissue, activation and removal', async () => {
    const store = await setup(() => instant)
    expect(await store.getByInviteHash(invite.tokenHash)).toBeNull()
    await store.create(pending)
    expect(await store.getByInviteHash(invite.tokenHash)).toEqual(await store.getByEmail(pending.email))
    const read = (await store.getByInviteHash(invite.tokenHash))!
    read.invite!.tokenHash = 'changed'
    expect(await store.getByInviteHash(invite.tokenHash)).toEqual(await store.getByEmail(pending.email))
    const next = createInvite('new-token', () => instant)
    await store.reissue(pending.email, next)
    expect(await store.getByInviteHash(invite.tokenHash)).toBeNull()
    expect(await store.getByInviteHash(next.tokenHash)).toEqual(await store.getByEmail(pending.email))
    await store.activate(pending.email, 'account')
    expect(await store.getByInviteHash(next.tokenHash)).toBeNull()
    await store.create({ ...pending, email: 'another@example.com' })
    await store.remove('another@example.com')
    expect(await store.getByInviteHash(invite.tokenHash)).toBeNull()
  })
  it('normalizes keys, refuses duplicates, lists, updates roles and removes', async () => {
    const store = await setup(() => instant)
    expect(await store.getByEmail(pending.email)).toBeNull()
    expect(await store.getByUid('missing')).toBeNull()
    expect(await store.create(pending)).toBe('ok')
    expect(await store.create({ ...pending, email: 'person@example.com', role: 'owner' })).toBe('exists')
    const member = await store.getByEmail(' PERSON@example.com ')
    expect(member).toEqual({ ...pending, email: 'person@example.com', status: 'pending', uid: null, createdAt: instant, authorityEpoch: 1 })
    expect(await store.list()).toEqual([member])
    expect(await store.updateRole(pending.email, 'owner')).toBe('ok')
    expect(await store.getByEmail(pending.email)).toEqual({ ...member, role: 'owner', authorityEpoch: member!.authorityEpoch! + 1 })
    expect(await store.remove(pending.email)).toBe('ok')
    expect(await store.list()).toEqual([])
    expect(await store.remove(pending.email)).toBe('not_found')
    expect(await store.updateRole(pending.email, 'owner')).toBe('not_found')
    expect(await store.reissue(pending.email, invite)).toBe('not_found')
    expect(await store.activate(pending.email, 'account')).toBe('not_found')
  })

  it('reissues an expired invite, invalidates the old hash, activates once and binds the uid', async () => {
    let now = instant
    const store = await setup(() => now)
    await store.create(pending)
    now = invite.expiresAt
    const expired = await store.getByEmail(pending.email)
    expect(await store.activate(pending.email, 'account', invite.tokenHash)).toBe('expired')
    expect(await store.getByEmail(pending.email)).toEqual(expired)
    const next = createInvite('next-token', () => now)
    expect(await store.reissue(pending.email, next)).toBe('ok')
    expect(await store.getByEmail(pending.email)).toEqual({ ...expired, invite: next })
    expect(await store.activate(pending.email, 'account', invite.tokenHash)).toBe('hash_mismatch')
    expect(await store.getByUid('account')).toBeNull()
    expect(await store.activate(pending.email, 'account', next.tokenHash)).toBe('ok')
    const active = { ...expired, authorityEpoch: expired!.authorityEpoch! + 1, invite: null, status: 'active', uid: 'account' }
    expect(await store.getByEmail(pending.email)).toEqual(active)
    expect(await store.getByUid('account')).toEqual(active)
    expect(await store.activate(pending.email, 'other')).toBe('invalid_state')
    expect(await store.reissue(pending.email, invite)).toBe('invalid_state')
    expect(await store.getByUid('account')).toEqual(active)
    await store.remove(pending.email)
    expect(await store.getByUid('account')).toBeNull()
  })

  it('supports activation by verified email without a supplied hash and the seed-only no-invite record', async () => {
    const store = await setup(() => instant)
    await store.create(pending)
    expect(await store.activate(pending.email, 'account')).toBe('ok')
    await store.upsertSeed({ ...pending, email: ' OWNER@Example.com ', status: 'pending', invite: null, uid: null, createdAt: instant })
    expect(await store.activate('owner@example.com', 'owner-account', 'unknown')).toBe('hash_mismatch')
    expect(await store.activate('owner@example.com', 'owner-account')).toBe('ok')
    const member = (await store.getByUid('owner-account'))!
    await store.upsertSeed({ ...member, role: 'owner', uid: 'replacement' })
    expect(await store.getByUid('owner-account')).toBeNull()
    expect(await store.getByEmail('owner@example.com')).toEqual({ ...member, role: 'owner', uid: 'replacement', authorityEpoch: member.authorityEpoch! + 1 })
  })

  it('allows only one concurrent create and one concurrent activation', async () => {
    const store = await setup(() => instant)
    expect((await Promise.all([store.create(pending), store.create(pending)])).sort()).toEqual(['exists', 'ok'])
    expect((await Promise.all([store.activate(pending.email, 'one'), store.activate(pending.email, 'two')])).sort()).toEqual(['invalid_state', 'ok'])
  }, 20000)

  it('keeps email keys containing path characters distinct', async () => {
    const store = await setup(() => instant)
    const emails = ['a/b@example.com', 'a%2fb@example.com']
    for (const email of emails) expect(await store.create({ ...pending, email })).toBe('ok')
    for (const email of emails) expect(await store.getByEmail(email)).toMatchObject({ email })
    expect(await store.list()).toHaveLength(2)
  })
}
