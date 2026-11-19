import { beforeAll, expect, test, vi } from 'vitest'
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  UnsecuredJWT,
} from 'jose'
import type { JWTPayload } from 'jose'
import {
  authEmulatorEnabled,
  verifyIdToken,
} from '../../lib/auth/verify-id-token'
import { authenticate, parseOwnerUids } from '../../lib/auth/actor'
import { googleSecureTokenJwks } from '../../lib/auth/google-jwks'
import { createMemoryMembersStore } from '../../lib/members/memory-store'
import { createInvite } from '../../lib/members/invite'
import type { Member, MembersStore } from '../../lib/members/types'

const projectId = 'demo-auth'
const now = 1800000000
let privateKey: CryptoKey
let jwks: ReturnType<typeof createLocalJWKSet>

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  jwks = createLocalJWKSet({
    keys: [
      { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' },
    ],
  })
})

/**
 * Provide a test credential so the request can exercise the intended authentication
 * path.
 */
async function token(overrides: JWTPayload = {}) {
  return new SignJWT({
    sub: 'user-one',
    email: 'user@example.com',
    auth_time: now - 60,
    iat: now - 60,
    exp: now + 3600,
    aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(privateKey)
}

/**
 * Sign the requested test claims and verify the token against the fixture clock and
 * keys.
 */
async function verify(overrides: JWTPayload = {}) {
  return verifyIdToken(await token(overrides), {
    projectId,
    jwks,
    /** Read the test clock used by this operation to calculate timestamps and deadlines. */ now: () =>
      now * 1000,
  })
}

test('accepts a valid token', async () => {
  expect(await verify()).toEqual({
    uid: 'user-one',
    email: 'user@example.com',
    signInProvider: null,
    emailVerified: false,
  })
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
  expect(
    await verifyIdToken(await token(), {
      projectId,
      /** Simulate an unavailable signing key lookup so verification can exercise its failure response. */ jwks: async () => {
        throw new Error('unavailable')
      },
    })
  ).toBeNull()
})

/** Build an unsigned token shaped like the Firebase Auth emulator's. */
function emulatorToken(project = projectId) {
  return new UnsecuredJWT({
    sub: 'user-one',
    auth_time: now - 60,
    iat: now - 60,
    exp: now + 3600,
    aud: project,
    iss: `https://securetoken.google.com/${project}`,
    firebase: { sign_in_provider: 'password' },
  }).encode()
}

test('accepts unsigned emulator tokens only for an enabled demo project', async () => {
  const clock = () => now * 1000
  expect(
    await verifyIdToken(emulatorToken(), {
      projectId,
      jwks,
      now: clock,
      emulator: true,
    })
  ).toMatchObject({ uid: 'user-one', signInProvider: 'password' })
  expect(
    await verifyIdToken(emulatorToken(), { projectId, jwks, now: clock })
  ).toBeNull()
  expect(
    await verifyIdToken(emulatorToken('real-project'), {
      projectId: 'real-project',
      jwks,
      now: clock,
      emulator: true,
    })
  ).toBeNull()
})

test.each([
  [{ FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' }, 'demo-x', true],
  [{}, 'demo-x', false],
  [{ FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' }, 'real-project', false],
  [
    { FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099', VERCEL_ENV: 'preview' },
    'demo-x',
    false,
  ],
  [
    { FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099', NODE_ENV: 'production' },
    'demo-x',
    false,
  ],
])('gates the Auth emulator for %j on %s', (env, project, enabled) => {
  expect(authEmulatorEnabled(project, env)).toBe(enabled)
})

test('omits an absent email', async () => {
  expect(await verify({ email: undefined })).toEqual({
    uid: 'user-one',
    signInProvider: null,
    emailVerified: false,
  })
})

test('reuses the Google key resolver', () => {
  expect(googleSecureTokenJwks()).toBe(googleSecureTokenJwks())
})

/**
 * Check that the request is rejected as unauthorized with the expected private response.
 */
async function expectUnauthorized(
  request: Request,
  verify = vi.fn(async () => null)
) {
  const result = await authenticate(request, {
    verify,
    ownerUids: [],
    members: createMemoryMembersStore(),
  })
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
  await expectUnauthorized(
    new Request('https://example.com', {
      headers: { Authorization: 'Bearer bad' },
    })
  )
})

test.each(['Basic token', 'Bearer', 'Bearer one two'])(
  'rejects malformed authorization %s',
  async (authorization) => {
    await expectUnauthorized(
      new Request('https://example.com', { headers: { authorization } })
    )
  }
)

test('a break-glass uid is Owner without accessing Members', async () => {
  const members = createMemoryMembersStore()
  members.getByUid = members.getByEmail = async () => {
    throw new Error('Members unavailable')
  }
  expect(await authorize(members, { sub: 'owner-one' }, ['owner-one'])).toEqual(
    { ok: true, actor: { uid: 'owner-one', name: 'user', role: 'owner' } }
  )
})

test('parseOwnerUids trims and ignores blanks', () => {
  expect(parseOwnerUids(' one, ,two, ')).toEqual(['one', 'two'])
  expect(parseOwnerUids(undefined)).toEqual([])
})

test.each([
  [{ name: '  Jane Smith  ' }, 'Jane Smith'],
  [{ name: 'Jane', email: 'other@example.com' }, 'Jane'],
  [{ name: '   ', email: '  jane.doe@example.com' }, 'jane.doe'],
  [{ name: '', email: 'user@example.com' }, 'user'],
  [{ name: 123, email: 'user@example.com' }, 'user'],
  [{ email: '  jane  @example.com' }, 'jane'],
  [{ name: '  ' + 'n'.repeat(61) + '  ' }, 'n'.repeat(60)],
  [{ email: '  ' + 'e'.repeat(61) + '@example.com' }, 'e'.repeat(60)],
  [{ name: undefined, email: undefined }, null],
  [{ name: null, email: 123 }, null],
  [{ name: '   ', email: '  ' }, null],
  [{ email: '@example.com' }, null],
])(
  'authenticates with a normalized display name from claims %j',
  async (claims, name) => {
    const result = await authenticate(
      new Request('https://example.com', {
        headers: { Authorization: `Bearer ${await token(claims)}` },
      }),
      {
        /**
         * Use the fixture project, signing keys and clock while the authentication test
         * resolves membership.
         */
        verify: (value) =>
          verifyIdToken(value, {
            projectId,
            jwks,
            /** Read the test clock used by this operation to calculate timestamps and deadlines. */ now: () =>
              now * 1000,
          }),
        ownerUids: [],
        members: createMemoryMembersStore([passwordMember]),
      }
    )
    expect(result).toEqual({
      ok: true,
      actor: { uid: 'user-one', role: 'editor', name },
    })
  }
)

const instant = new Date(now * 1000).toISOString()
const passwordMember: Member = {
  email: 'user@example.com',
  uid: 'user-one',
  role: 'editor',
  signIn: 'password',
  status: 'active',
  invite: null,
  invitedBy: null,
  createdAt: instant,
}
const googleMember: Member = {
  ...passwordMember,
  signIn: 'google',
  status: 'pending',
  uid: null,
  invite: createInvite('invite', () => instant),
}
const googleClaims = {
  firebase: { sign_in_provider: 'google.com' },
  email_verified: true,
}

/**
 * Authenticate a signed fixture request using the supplied member store and token
 * claims.
 */
async function authorize(
  members: MembersStore,
  claims: JWTPayload = {},
  ownerUids: string[] = []
) {
  return authenticate(
    new Request('https://example.com', {
      headers: { Authorization: `Bearer ${await token(claims)}` },
    }),
    {
      /**
       * Verify the bearer token against the same project and instant used by the signing
       * fixture.
       */
      verify: (value) =>
        verifyIdToken(value, {
          projectId,
          jwks,
          /** Read the test clock used by this operation to calculate timestamps and deadlines. */ now: () =>
            now * 1000,
        }),
      ownerUids,
      members,
      /** Read the test clock used by this operation to calculate timestamps and deadlines. */ now: () =>
        instant,
    }
  )
}

/**
 * Check that the signed-in account receives the expected response when it lacks
 * membership.
 */
async function expectNotMember(members: MembersStore, claims: JWTPayload = {}) {
  const result = await authorize(members, claims)
  if (result.ok) throw new Error('Expected non-Member refusal')
  expect(result.response.status).toBe(403)
  expect(result.response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await result.response.json()).toEqual({ error: 'not_member' })
}

test('returns only a proven email flag and the signed provider claim', async () => {
  expect(await verify(googleClaims)).toMatchObject({
    signInProvider: 'google.com',
    emailVerified: true,
  })
  expect(
    await verify({
      firebase: { sign_in_provider: 123 },
      email_verified: 'true',
    })
  ).toMatchObject({ signInProvider: null, emailVerified: false })
})

test.each([
  [
    'unverified Google email',
    googleMember,
    { ...googleClaims, email_verified: false },
  ],
  [
    'missing verification',
    googleMember,
    { ...googleClaims, email_verified: undefined },
  ],
  [
    'nonboolean verification',
    googleMember,
    { ...googleClaims, email_verified: 'true' },
  ],
  [
    'password provider claiming a Google email',
    googleMember,
    { ...googleClaims, firebase: { sign_in_provider: 'password' } },
  ],
  ['missing provider', googleMember, { email_verified: true }],
  [
    'wrong uid claiming a password email',
    passwordMember,
    { sub: 'different-user', firebase: { sign_in_provider: 'password' } },
  ],
  [
    'active Google Member bound to another uid',
    { ...googleMember, status: 'active', uid: 'different-user', invite: null },
    googleClaims,
  ],
  [
    'expired pending Member',
    {
      ...googleMember,
      invite: createInvite('old', () =>
        new Date((now - 8 * 86400) * 1000).toISOString()
      ),
    },
    googleClaims,
  ],
  ['pending password Member', { ...passwordMember, status: 'pending' }, {}],
] as [string, Member, JWTPayload][])(
  'refuses %s',
  async (_, member, claims) => {
    const members = createMemoryMembersStore([member], () => instant)
    await expectNotMember(members, claims)
    expect(await members.list()).toEqual([member])
  }
)

test('refuses a non-Member even with a verified Google identity', async () => {
  await expectNotMember(createMemoryMembersStore(), googleClaims)
})

test('accepts the bound password uid and reads role changes and removal on the next request', async () => {
  const members = createMemoryMembersStore([passwordMember])
  expect(
    await authorize(members, { firebase: { sign_in_provider: 'password' } })
  ).toEqual({
    ok: true,
    actor: { uid: 'user-one', name: 'user', role: 'editor' },
  })
  await members.updateRole(passwordMember.email, 'owner')
  expect(await authorize(members)).toMatchObject({
    ok: true,
    actor: { role: 'owner' },
  })
  await members.remove(passwordMember.email)
  await expectNotMember(members)
})

test.each([googleMember.invite, null])(
  'activates a pending Google Member by normalized email, including the seeded Owner',
  async (invite) => {
    const members = createMemoryMembersStore(
      [{ ...googleMember, role: 'owner', invite }],
      () => instant
    )
    expect(
      await authorize(members, { ...googleClaims, email: ' USER@Example.com ' })
    ).toMatchObject({ ok: true, actor: { role: 'owner', uid: 'user-one' } })
    expect(await members.getByEmail(googleMember.email)).toEqual({
      ...googleMember,
      role: 'owner',
      status: 'active',
      uid: 'user-one',
      invite: null,
      authorityEpoch: 1,
    })
    expect(await authorize(members, googleClaims)).toMatchObject({
      ok: true,
      actor: { role: 'owner' },
    })
  }
)

test('concurrent first Google requests accept the same bound account', async () => {
  const members = createMemoryMembersStore([googleMember], () => instant)
  const results = await Promise.all([
    authorize(members, googleClaims),
    authorize(members, googleClaims),
  ])
  expect(results.every((result) => result.ok)).toBe(true)
  expect(await members.getByUid('user-one')).toMatchObject({
    status: 'active',
    invite: null,
  })
})

test('an activation race cannot grant access to another uid or a removed Member', async () => {
  for (const removed of [false, true]) {
    const members = createMemoryMembersStore([googleMember], () => instant)
    const activate = members.activate
    members.activate = async (email) => {
      if (removed) {
        await members.remove(email)
        return 'not_found'
      }
      await activate(email, 'different-user')
      return 'invalid_state'
    }
    await expectNotMember(members, googleClaims)
  }
})
