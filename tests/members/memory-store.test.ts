import { expect, it } from 'vitest'
import { createMemoryMembersStore } from '../../lib/members/memory-store'
import { membersStoreScenarios } from './store-scenarios'

membersStoreScenarios(async now => createMemoryMembersStore([], now))

it('isolates stored records from mutations of inputs and returned values', async () => {
  const member = { email: 'person@example.com', role: 'owner', signIn: 'google', status: 'pending', invite: { tokenHash: 'hash', issuedAt: '2026-11-16', expiresAt: '2026-11-23' }, uid: null, invitedBy: null, createdAt: '2026-11-16' } as const
  const original = structuredClone(member)
  const store = createMemoryMembersStore([member])
  const result = (await store.list())[0]
  result.invite!.tokenHash = 'changed'
  expect(await store.getByEmail(member.email)).toEqual(original)
})
