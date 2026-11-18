import { beforeEach, expect, test, vi } from 'vitest'
import { POST } from '../app/api/sign-in/check/route'
import { createMemoryMembersStore } from '../lib/members/memory-store'
import type { Member } from '../lib/members/types'

const mocks = vi.hoisted(() => ({ membersStore: vi.fn() }))
vi.mock('../lib/server/members', () => mocks)
beforeEach(() => mocks.membersStore.mockReturnValue(createMemoryMembersStore()))
/** Build the POST request the route fixture passes to its handler. */
function request(body: unknown) {
  return new Request('https://example.com/api/sign-in/check', { method: 'POST', body: JSON.stringify(body) })
}
test('unknown email reveals only that it is not invited', async () => {
  const response = await POST(request({ email: 'nobody@example.com' }))
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ invited: false })
})
test.each([
  ['google', 'pending'], ['google', 'active'], ['google', 'expired'], ['password', 'active'],
] as const)('%s Member with %s status reveals only sign-in method and status', async (signIn, status) => {
  const member: Member = {
    email: 'member@example.com', role: 'owner', signIn, status: status === 'active' ? 'active' : 'pending',
    invite: { tokenHash: 'secret', issuedAt: '', expiresAt: status === 'expired' ? '2000-01-01' : '2099-01-01' },
    uid: 'private-uid', invitedBy: 'private-inviter', createdAt: '',
  }
  mocks.membersStore.mockReturnValue(createMemoryMembersStore([member]))
  const response = await POST(request({ email: ' Member@Example.com ' }))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ invited: true, signIn, status })
})
test.each([null, [], {}, { email: 1 }, { email: '' }, { email: 'a' }, { email: 'a@@example.com' }, { email: 'a b@example.com' }, { email: 'a@example..com' }, { email: `${'a'.repeat(243)}@example.com` }, { email: 'a@example.com', role: 'owner' }])('invalid input returns 400', async body => {
  const response = await POST(request(body))
  expect(response.status).toBe(400)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
})
test('malformed JSON returns 400', async () => {
  expect((await POST(new Request('https://example.com', { method: 'POST', body: '{' }))).status).toBe(400)
})
