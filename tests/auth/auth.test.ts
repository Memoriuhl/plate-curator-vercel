import { beforeAll, expect, test, vi } from 'vitest'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { JWTPayload } from 'jose'
import { verifyIdToken } from '../../lib/auth/verify-id-token'
import { authenticate, parseOwnerUids, roleFor } from '../../lib/auth/actor'
import { googleSecureTokenJwks } from '../../lib/auth/google-jwks'

const projectId = 'demo-auth'
const now = 1800000000
let privateKey: CryptoKey
let jwks: ReturnType<typeof createLocalJWKSet>

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256' }] })
})

async function token(overrides: JWTPayload = {}) {
  return new SignJWT({ sub: 'user-one', email: 'user@example.com', auth_time: now - 60, iat: now - 60, exp: now + 3600, aud: projectId, iss: `https://securetoken.google.com/${projectId}`, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(privateKey)
}

async function verify(overrides: JWTPayload = {}) {
  return verifyIdToken(await token(overrides), { projectId, jwks, now: () => now * 1000 })
}

test('accepts a valid token', async () => {
  expect(await verify()).toEqual({ uid: 'user-one', email: 'user@example.com' })
})

test.each([
  ['an expired token', { exp: now - 1 }],
  ['the wrong audience', { aud: 'demo-other' }],
  ['the wrong issuer', { iss: 'https://example.com' }],
  ['an empty subject', { sub: '' }],
  ['an oversized subject', { sub: 'a'.repeat(129) }],
  ['a missing subject', { sub: undefined }],
  ['an auth_time in the future', { auth_time: now + 1 }],
  ['a missing auth_time', { auth_time: undefined }],
  ['a nonnumeric auth_time', { auth_time: 'yesterday' }],
  ['a missing expiration', { exp: undefined }],
])('rejects %s', async (_, claims) => {
  expect(await verify(claims)).toBeNull()
})

test('rejects malformed tokens and key lookup failures', async () => {
  expect(await verifyIdToken('bad', { projectId, jwks })).toBeNull()
  expect(await verifyIdToken(await token(), { projectId, jwks: async () => { throw new Error('unavailable') } })).toBeNull()
})

test('omits an absent email', async () => {
  expect(await verify({ email: undefined })).toEqual({ uid: 'user-one' })
})

test('reuses the Google key resolver', () => {
  expect(googleSecureTokenJwks()).toBe(googleSecureTokenJwks())
})

async function expectUnauthorized(request: Request, verify = vi.fn(async () => null)) {
  const result = await authenticate(request, { verify, ownerUids: [] })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('Expected authentication failure')
  expect(result.response.status).toBe(401)
  expect(result.response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await result.response.json()).toEqual({ error: 'unauthenticated' })
}

test('authenticate answers 401 without a bearer header', async () => {
  const verify = vi.fn(async () => null)
  await expectUnauthorized(new Request('https://example.com'), verify)
  expect(verify).not.toHaveBeenCalled()
})

test('authenticate answers 401 for a bad token', async () => {
  await expectUnauthorized(new Request('https://example.com', { headers: { Authorization: 'Bearer bad' } }))
})

test.each(['Basic token', 'Bearer', 'Bearer one two'])('rejects malformed authorization %s', async (authorization) => {
  await expectUnauthorized(new Request('https://example.com', { headers: { authorization } }))
})

test('an allowlisted uid is owner and anyone else is editor', async () => {
  expect(roleFor('owner-one', ['owner-one'])).toBe('owner')
  expect(roleFor('user-one', ['owner-one'])).toBe('editor')
  for (const uid of ['owner-one', 'user-one']) {
    const verify = vi.fn(async () => ({ uid }))
    expect(await authenticate(new Request('https://example.com', { headers: { Authorization: 'Bearer signed-token' } }), { verify, ownerUids: ['owner-one'] }))
      .toEqual({ ok: true, actor: { uid, role: uid === 'owner-one' ? 'owner' : 'editor' } })
    expect(verify).toHaveBeenCalledWith('signed-token')
  }
})

test('parseOwnerUids trims and ignores blanks', () => {
  expect(parseOwnerUids(' one, ,two, ')).toEqual(['one', 'two'])
  expect(parseOwnerUids(undefined)).toEqual([])
})
