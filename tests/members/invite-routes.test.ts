import { beforeEach, expect, test, vi } from 'vitest'
import { POST } from '../../app/api/members/[email]/invite/route'
import { GET } from '../../app/api/invites/[token]/route'
import { createMemoryMembersStore } from '../../lib/members/memory-store'
import { createInvite, generateInviteToken, hashInviteToken } from '../../lib/members/invite'

const mocks = vi.hoisted(() => ({ currentActor: vi.fn(), membersStore: vi.fn() }))
vi.mock('../../lib/server/context', () => ({ currentActor: mocks.currentActor }))
vi.mock('../../lib/server/members', () => ({ membersStore: mocks.membersStore }))
vi.mock('next/server', () => ({ connection: async () => {} }))
let store = createMemoryMembersStore()
const request = new Request('https://example.com/api/members/person%40example.com/invite', { method: 'POST' })
const context = { params: Promise.resolve({ email: 'person@example.com' }) }
const lookup = (token: string) => GET(new Request(`https://example.com/api/invites/${encodeURIComponent(token)}`), { params: Promise.resolve({ token }) })
async function create(token = generateInviteToken(), issuedAt = new Date().toISOString()) {
  await store.create({ email: 'person@example.com', role: 'editor', signIn: 'google', invitedBy: 'owner', invite: createInvite(token, () => issuedAt) })
  return token
}

beforeEach(() => {
  store = createMemoryMembersStore()
  mocks.membersStore.mockReset().mockReturnValue(store)
  mocks.currentActor.mockReset().mockResolvedValue({ ok: true, actor: { uid: 'owner', role: 'owner' } })
})

test.each(['pending', 'expired'])('Owner reissues a %s invite and resets seven-day expiry', async status => {
  const old = await create(undefined, status === 'expired' ? '2000-01-01T12:00:00Z' : new Date().toISOString())
  const before = Date.now()
  const response = await POST(request, context)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  const body = await response.json()
  expect(Object.keys(body)).toEqual(['inviteUrl'])
  const url = new URL(body.inviteUrl)
  expect(url.origin).toBe('https://example.com')
  const token = url.pathname.split('/').pop()!
  expect(token).not.toBe(old)
  const member = (await store.getByEmail('person@example.com'))!
  expect(member.invite!.tokenHash).toBe(hashInviteToken(token))
  expect(Date.parse(member.invite!.issuedAt)).toBeGreaterThanOrEqual(before)
  expect(Date.parse(member.invite!.expiresAt) - Date.parse(member.invite!.issuedAt)).toBe(7 * 86400000)
  expect(await (await lookup(old)).json()).toEqual({ status: 'invalid' })
  expect(await (await lookup(token)).json()).toEqual({ status: 'valid', email: 'person@example.com' })
})

test('Editor cannot reissue or access the store', async () => {
  mocks.currentActor.mockResolvedValue({ ok: true, actor: { role: 'editor' } })
  const response = await POST(request, context)
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'forbidden' })
  expect(mocks.membersStore).not.toHaveBeenCalled()
})

test('non-Members keep the authentication refusal', async () => {
  mocks.currentActor.mockResolvedValue({ ok: false, response: Response.json({ error: 'not_member' }, { status: 403 }) })
  expect(await (await POST(request, context)).json()).toEqual({ error: 'not_member' })
})

test('active Members cannot be reissued and missing Members return 404', async () => {
  expect((await POST(request, context)).status).toBe(404)
  await create()
  await store.activate('person@example.com', 'account')
  const before = await store.getByEmail('person@example.com')
  const response = await POST(request, context)
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'invalid_state' })
  expect(await store.getByEmail('person@example.com')).toEqual(before)
})

test.each(['', 'not-an-email', 'a@@example.com', 'a@example..com'])('invalid email is rejected before store access', async email => {
  expect((await POST(request, { params: Promise.resolve({ email }) })).status).toBe(400)
  expect(mocks.membersStore).not.toHaveBeenCalled()
})

test('public lookup discloses only invited email and validity', async () => {
  const token = await create()
  const response = await lookup(token)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ status: 'valid', email: 'person@example.com' })
  expect(mocks.currentActor).not.toHaveBeenCalled()
})

test('expired lookup discloses only email and expired status', async () => {
  const token = await create(undefined, '2000-01-01T12:00:00Z')
  expect(await (await lookup(token)).json()).toEqual({ status: 'expired', email: 'person@example.com' })
})

test('activation consumes the link and used is indistinguishable from unknown', async () => {
  const token = await create()
  await store.activate('person@example.com', 'account')
  expect(await (await lookup(token)).json()).toEqual({ status: 'invalid' })
  expect(await (await lookup(generateInviteToken())).json()).toEqual({ status: 'invalid' })
})

test.each(['short', 'a'.repeat(257), 'a/'.repeat(25)])('malformed tokens return invalid without a database lookup', async token => {
  const response = await lookup(token)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ status: 'invalid' })
  expect(mocks.membersStore).not.toHaveBeenCalled()
})
