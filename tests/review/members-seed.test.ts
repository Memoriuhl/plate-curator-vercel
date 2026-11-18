import { expect, it } from 'vitest'
import { createMemoryMembersStore } from '../../lib/members/memory-store'
import { seedMembers } from '../../lib/review/members-seed'

const input = {
  projectId: 'license-plate-game-staging',
  env: { SEED_DEMO_OWNER_EMAIL: ' Demo.Owner@Example.com ', SEED_DEMO_OWNER_UID: 'demo-owner', SEED_DEMO_EDITOR_EMAIL: 'editor@example.com', SEED_DEMO_EDITOR_UID: 'demo-editor', SEED_OWNER_GOOGLE_EMAIL: 'owner@example.com' },
  /** Pin the operation clock so timestamps and lease checks are reproducible. */
  now: () => '2026-11-16T12:00:00.000Z',
}

it('seeds three exact records and converges on the same records on later runs', async () => {
  const store = createMemoryMembersStore()
  expect(await seedMembers(store, input)).toEqual({ active: 2, pending: 1 })
  const first = await store.list()
  expect(first).toEqual([
    { email: 'demo.owner@example.com', uid: 'demo-owner', role: 'owner', signIn: 'password', status: 'active', invite: null, invitedBy: null, createdAt: input.now(), authorityEpoch: 1 },
    { email: 'editor@example.com', uid: 'demo-editor', role: 'editor', signIn: 'password', status: 'active', invite: null, invitedBy: null, createdAt: input.now(), authorityEpoch: 1 },
    { email: 'owner@example.com', uid: null, role: 'owner', signIn: 'google', status: 'pending', invite: null, invitedBy: null, createdAt: input.now(), authorityEpoch: 1 },
  ])
  await store.updateRole('editor@example.com', 'owner')
  await seedMembers(store, { ...input, /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () => '2026-11-17T12:00:00.000Z' })
  expect(await store.list()).toEqual(first.map(member => ({ ...member, authorityEpoch: member.email === 'editor@example.com' ? 3 : 1 })))
  expect(await store.activate('owner@example.com', 'google-owner')).toBe('ok')
})

it.each(['other-project', '', undefined])('refuses non-staging projects before accessing the store', async projectId => {
  const store = createMemoryMembersStore()
  store.getByEmail = async () => { throw new Error('Store must not be called') }
  await expect(seedMembers(store, { ...input, projectId, env: {} })).rejects.toThrow('requires the staging project')
})

it.each(Object.keys(input.env) as (keyof typeof input.env)[])('names missing input %s without revealing values or writing', async key => {
  const store = createMemoryMembersStore()
  await expect(seedMembers(store, { ...input, env: { ...input.env, [key]: ' ' } })).rejects.toThrow(`Missing seed inputs: ${key}`)
  expect(await store.list()).toEqual([])
})

it('reports every missing variable together and rejects colliding identities before writing', async () => {
  const store = createMemoryMembersStore()
  await expect(seedMembers(store, { ...input, env: {} })).rejects.toThrow(`Missing seed inputs: ${Object.keys(input.env).join(', ')}`)
  await expect(seedMembers(store, { ...input, env: { ...input.env, SEED_OWNER_GOOGLE_EMAIL: input.env.SEED_DEMO_OWNER_EMAIL } })).rejects.toThrow('distinct emails and account ids')
  await expect(seedMembers(store, { ...input, env: { ...input.env, SEED_DEMO_EDITOR_UID: input.env.SEED_DEMO_OWNER_UID } })).rejects.toThrow('distinct emails and account ids')
  expect(await store.list()).toEqual([])
})
