import { beforeEach, expect, test, vi } from 'vitest'
import { GET, POST } from '../../app/api/members/route'
import { createMemoryMembersStore } from '../../lib/members/memory-store'
import { hashInviteToken } from '../../lib/members/invite'
import type { Member } from '../../lib/members/types'

const mocks = vi.hoisted(() => ({ currentActor: vi.fn(), membersStore: vi.fn() }))
vi.mock('../../lib/server/context', () => ({ currentActor: mocks.currentActor }))
vi.mock('../../lib/server/members', () => ({ membersStore: mocks.membersStore }))
vi.mock('next/server', () => ({ /** Resolve the request barrier without requiring a Next.js request runtime. */ connection: async () => {} }))
let store = createMemoryMembersStore()
/** Build the POST request the route fixture passes to its handler. */
const request = (body: unknown) => new Request('https://example.com/api/members', { method: 'POST', body: JSON.stringify(body) })
const member: Member = { email: 'person@example.com', role: 'editor', signIn: 'google', status: 'pending', invite: { tokenHash: 'private-hash', issuedAt: '2026-01-01', expiresAt: '2000-01-01' }, uid: 'private-account', invitedBy: 'owner', createdAt: '2026-01-01' }

beforeEach(() => {
  store = createMemoryMembersStore()
  mocks.membersStore.mockReset().mockReturnValue(store)
  mocks.currentActor.mockResolvedValue({ ok: true, actor: { uid: 'owner', name: null, role: 'owner' } })
})

test('Owner lists public Member details and derived statuses without invite hashes or bound account ids', async () => {
  await store.upsertSeed(member)
  await store.upsertSeed({ ...member, email: 'active@example.com', status: 'active', invite: null })
  await store.upsertSeed({ ...member, email: 'pending@example.com', uid: null, invite: { ...member.invite!, expiresAt: '2099-01-01' } })
  const response = await GET(request(null))
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  const body = await response.json()
  expect(body.map((entry: { status: string }) => entry.status)).toEqual(['active', 'pending', 'expired'])
  expect(body[2]).toEqual({ email: member.email, role: member.role, signIn: member.signIn, status: 'expired', invitedBy: member.invitedBy, createdAt: member.createdAt })
  expect(JSON.stringify(body)).not.toMatch(/tokenHash|private-hash|private-account|"uid"/)
})

test.each([GET, POST])('Editor is refused before any store access', async handler => {
  mocks.currentActor.mockResolvedValue({ ok: true, actor: { uid: 'editor', role: 'editor' } })
  const response = await handler(request({ email: 'person@example.com', role: 'editor' }))
  expect(response.status).toBe(403)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ error: 'forbidden' })
  expect(mocks.membersStore).not.toHaveBeenCalled()
})

test.each([GET, POST])('preserves not_member responses from authentication', async handler => {
  mocks.currentActor.mockResolvedValue({ ok: false, response: Response.json({ error: 'not_member' }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } }) })
  const response = await handler(request({}))
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'not_member' })
  expect(mocks.membersStore).not.toHaveBeenCalled()
})

test.each(['editor', 'owner'])('creates a Google %s and returns its link only in the creation response', async role => {
  const before = Date.now()
  const response = await POST(request({ email: ' Person@Example.com ', role }))
  expect(response.status).toBe(201)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  const body = await response.json()
  const url = new URL(body.inviteUrl)
  expect(url.origin).toBe('https://example.com')
  expect(url.pathname).toMatch(/^\/invite\/[A-Za-z0-9_-]{43,}$/)
  const token = url.pathname.split('/').pop()!
  const stored = (await store.getByEmail('person@example.com'))!
  expect(stored).toMatchObject({ email: 'person@example.com', role, signIn: 'google', status: 'pending', uid: null, invitedBy: 'owner', invite: { tokenHash: hashInviteToken(token) } })
  expect(Date.parse(stored.invite!.issuedAt)).toBeGreaterThanOrEqual(before)
  expect(Date.parse(stored.invite!.expiresAt) - Date.parse(stored.invite!.issuedAt)).toBe(7 * 86400000)
  expect(JSON.stringify(stored)).not.toContain(token)
  expect(body.member).toEqual({ email: stored.email, role, signIn: 'google', status: 'pending', invitedBy: 'owner', createdAt: stored.createdAt })
  const list = await (await GET(request(null))).text()
  expect(list).not.toContain(token)
  expect(list).not.toContain('inviteUrl')
  expect(list).not.toContain('tokenHash')
  expect(list).not.toContain('"uid"')
})

test('refuses a duplicate normalized email without changing its invite', async () => {
  await POST(request({ email: 'person@example.com', role: 'editor' }))
  const before = await store.getByEmail('person@example.com')
  const response = await POST(request({ email: ' PERSON@example.com ', role: 'owner' }))
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'member_exists' })
  expect(await store.getByEmail('person@example.com')).toEqual(before)
})

test.each([null, [], {}, { email: 'person@example.com' }, { role: 'owner' }, { email: 12, role: 'editor' }, { email: '', role: 'editor' }, { email: 'not-an-email', role: 'editor' }, { email: 'a@@example.com', role: 'editor' }, { email: 'a@example..com', role: 'editor' }, { email: 'a b@example.com', role: 'editor' }, { email: `${'a'.repeat(243)}@example.com`, role: 'editor' }, { email: 'person@example.com', role: 'admin' }, { email: 'person@example.com', role: ['editor'] }, { email: 'person@example.com', role: 'editor', signIn: 'password' }, { email: 'person@example.com', role: 'editor', uid: 'account' }])('strictly rejects invalid bodies', async body => {
  const response = await POST(request(body))
  expect(response.status).toBe(400)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await store.list()).toEqual([])
})

test('rejects malformed JSON', async () => {
  expect((await POST(new Request('https://example.com/api/members', { method: 'POST', body: '{' }))).status).toBe(400)
})
