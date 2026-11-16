import { expect, it } from 'vitest'
import { createInvite } from '../../lib/members/invite'
import type { MembersStore, PendingMember } from '../../lib/members/types'

export const instant = '2026-11-16T12:00:00.000Z'
const invite = createInvite('first-token', () => instant)
const pending: PendingMember = { email: ' Person@Example.com ', role: 'editor', signIn: 'google', invitedBy: 'owner', invite }

export function membersStoreScenarios(setup: (now: () => string) => Promise<MembersStore>) {
  it('normalizes keys, refuses duplicates, lists, updates roles and removes', async () => {
    const store = await setup(() => instant)
    expect(await store.getByEmail(pending.email)).toBeNull()
    expect(await store.getByUid('missing')).toBeNull()
    expect(await store.create(pending)).toBe('ok')
    expect(await store.create({ ...pending, email: 'person@example.com', role: 'owner' })).toBe('exists')
    const member = await store.getByEmail(' PERSON@example.com ')
    expect(member).toEqual({ ...pending, email: 'person@example.com', status: 'pending', uid: null, createdAt: instant })
    expect(await store.list()).toEqual([member])
    expect(await store.updateRole(pending.email, 'owner')).toBe('ok')
    expect(await store.getByEmail(pending.email)).toEqual({ ...member, role: 'owner' })
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
    const active = { ...expired, invite: null, status: 'active', uid: 'account' }
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
    expect(await store.getByEmail('owner@example.com')).toEqual({ ...member, role: 'owner', uid: 'replacement' })
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
