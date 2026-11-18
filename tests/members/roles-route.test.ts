import { beforeEach, expect, test, vi } from 'vitest'
import { PATCH, DELETE } from '../../app/api/members/[email]/route'
import { authenticate } from '../../lib/auth/actor'
import { createMemoryMembersStore } from '../../lib/members/memory-store'
import type { Member } from '../../lib/members/types'

const mocks = vi.hoisted(() => ({
  currentActor: vi.fn(),
  membersStore: vi.fn(),
}))
vi.mock('../../lib/server/context', () => ({
  currentActor: mocks.currentActor,
}))
vi.mock('../../lib/server/members', () => ({
  membersStore: mocks.membersStore,
}))
let store = createMemoryMembersStore()
const member: Member = {
  email: 'owner@example.com',
  role: 'owner',
  signIn: 'password',
  status: 'active',
  uid: 'owner-account',
  invite: null,
  invitedBy: null,
  createdAt: '',
}
/** Build the member route parameters with the target email. */
const context = (email = member.email) => ({
  params: Promise.resolve({ email }),
})
/** Build the PATCH request the route fixture passes to its handler. */
const request = (body?: unknown) =>
  new Request('https://example.com/api/members/owner@example.com', {
    method: 'PATCH',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
beforeEach(() => {
  store = createMemoryMembersStore([
    member,
    {
      ...member,
      email: 'editor@example.com',
      role: 'editor',
      uid: 'editor-account',
    },
  ])
  mocks.membersStore.mockReset().mockReturnValue(store)
  mocks.currentActor.mockReset().mockResolvedValue({
    ok: true,
    actor: { uid: 'owner-account', role: 'owner' },
  })
})
test('promotes and demotes while another Owner remains', async () => {
  expect(
    (await PATCH(request({ role: 'owner' }), context('editor@example.com')))
      .status
  ).toBe(200)
  expect(await store.getByEmail('editor@example.com')).toMatchObject({
    role: 'owner',
  })
  expect(
    (await PATCH(request({ role: 'editor' }), context(' OWNER@Example.com ')))
      .status
  ).toBe(200)
  expect(await store.getByEmail(member.email)).toMatchObject({ role: 'editor' })
})
test.each([PATCH, DELETE])(
  'refuses the last Owner even when a break-glass Owner exists',
  async (handler) => {
    mocks.currentActor.mockResolvedValue({
      ok: true,
      actor: { uid: 'break-glass', role: 'owner' },
    })
    const response = await handler(request({ role: 'editor' }), context())
    expect(response.status).toBe(409)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: 'last_owner' })
    expect(await store.getByEmail(member.email)).toMatchObject({
      role: 'owner',
    })
  }
)
test('removal revokes the bound Member on their next authenticated request', async () => {
  const req = new Request('https://example.com/api/me', {
    headers: { Authorization: 'Bearer token' },
  })
  const deps = {
    members: store,
    ownerUids: [],
    /** Authenticate as a non-owner to exercise the role route's authorization guard. */ verify:
      async () => ({
        uid: 'editor-account',
        email: 'editor@example.com',
        emailVerified: false,
        signInProvider: 'password',
      }),
  }
  expect(await authenticate(req, deps)).toMatchObject({ ok: true })
  const response = await DELETE(request(), context('editor@example.com'))
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  const next = await authenticate(req, deps)
  expect(next.ok).toBe(false)
  if (!next.ok) {
    expect(next.response.status).toBe(403)
    expect(await next.response.json()).toEqual({ error: 'not_member' })
  }
})
test.each([PATCH, DELETE])(
  'Editors are refused before accessing the store',
  async (handler) => {
    mocks.currentActor.mockResolvedValue({
      ok: true,
      actor: { role: 'editor' },
    })
    const response = await handler(request({ role: 'owner' }), context())
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden' })
    expect(mocks.membersStore).not.toHaveBeenCalled()
  }
)
test.each([PATCH, DELETE])(
  'unknown Members return 404 and invalid email returns 400',
  async (handler) => {
    expect(
      (
        await handler(
          request({ role: 'owner' }),
          context('unknown@example.com')
        )
      ).status
    ).toBe(404)
    expect(
      (await handler(request({ role: 'owner' }), context('invalid'))).status
    ).toBe(400)
  }
)
test.each([
  null,
  [],
  {},
  { role: 'admin' },
  { role: 1 },
  { role: 'editor', uid: 'other' },
])('invalid PATCH bodies return 400', async (body) => {
  expect((await PATCH(request(body), context())).status).toBe(400)
})
test('malformed JSON returns 400', async () => {
  expect(
    (
      await PATCH(
        new Request('https://example.com', { method: 'PATCH', body: '{' }),
        context()
      )
    ).status
  ).toBe(400)
})
