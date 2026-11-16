import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createMemoryMembersStore } from '../../lib/members/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { issueWorkerToken } from '../../lib/jobs/tokens'

const mocks = vi.hoisted(() => ({ members: vi.fn(), jobs: vi.fn(), jwks: vi.fn(), review: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('workflow/api', () => ({ resumeHook: vi.fn(), start: vi.fn() }))
vi.mock('next/server', () => ({ connection: async () => {} }))
vi.mock('../../lib/server/members', () => ({ membersStore: mocks.members }))
vi.mock('../../lib/auth/google-jwks', () => ({ googleSecureTokenJwks: mocks.jwks }))
vi.mock('../../lib/gcp/firestore', () => ({ stagingFirestore: () => ({}) }))
vi.mock('../../lib/jobs/firestore-store', () => ({ firestoreJobsStore: mocks.jobs }))
vi.mock('../../lib/review/firestore-store', () => ({ firestoreReviewStore: mocks.review }))

const me = await import('../../app/api/me/route')
const batches = await import('../../app/api/batches/route')
const worker = await import('../../app/api/worker/claim/route')
const spikeStart = await import('../../app/api/spike/start/route')
const spikeResume = await import('../../app/api/spike/resume/route')
let privateKey: CryptoKey
let members = createMemoryMembersStore()
let jobs = createMemoryJobsStore(createMemoryStore([]), 'development')

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  mocks.jwks.mockReturnValue(createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256' }] }))
})
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'demo-auth')
  vi.stubEnv('CATALOG_SOURCE', 'firestore')
  vi.stubEnv('VERCEL_ENV', 'development')
  vi.stubEnv('OWNER_UIDS', '')
  members = createMemoryMembersStore()
  jobs = createMemoryJobsStore(createMemoryStore([]), 'development')
  mocks.members.mockReset().mockReturnValue(members)
  mocks.jobs.mockReturnValue(jobs)
  mocks.review.mockReturnValue(createMemoryStore([]))
})
afterEach(() => vi.unstubAllEnvs())

async function request(uid = 'outsider') {
  const now = Math.floor(Date.now() / 1000)
  const token = await new SignJWT({ sub: uid, email: 'user@example.com', auth_time: now - 60, iat: now - 60, exp: now + 3600, aud: 'demo-auth', iss: 'https://securetoken.google.com/demo-auth' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey)
  return new Request('https://example.com', { headers: { Authorization: `Bearer ${token}` } })
}

test.each([['me', me.GET], ['Batch list', batches.GET], ['Batch create', batches.POST]] as const)('a non-Member receives 403 not_member on %s', async (_, handler) => {
  const response = await handler(await request())
  expect(response.status).toBe(403)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ error: 'not_member' })
})

test('me returns the stored role and a removal ends access on the next request', async () => {
  await members.upsertSeed({ email: 'user@example.com', uid: 'member', role: 'editor', status: 'active', signIn: 'password', invite: null, invitedBy: null, createdAt: new Date().toISOString() })
  expect(await (await me.GET(await request('member'))).json()).toEqual({ uid: 'member', name: 'user', role: 'editor' })
  await members.remove('user@example.com')
  expect((await me.GET(await request('member'))).status).toBe(403)
})

test('fixture mode permits only break-glass Members and never reads Firestore', async () => {
  vi.stubEnv('CATALOG_SOURCE', 'fixture')
  vi.stubEnv('OWNER_UIDS', ' local-owner ')
  mocks.members.mockImplementation(() => { throw new Error('Firestore unavailable') })
  expect(await (await me.GET(await request('local-owner'))).json()).toMatchObject({ role: 'owner' })
  expect((await me.GET(await request())).status).toBe(403)
  expect(mocks.members).not.toHaveBeenCalled()
})

test('a valid worker token still claims work without a Member record', async () => {
  const deps = { store: jobs, baseline: async () => null, now: () => Date.now(), id: () => crypto.randomUUID(), leaseMs: 300000 }
  const issued = await issueWorkerToken(deps, { uid: 'issuer', name: null, role: 'owner' }, 'worker-one')
  if (!issued.ok) throw new Error('Worker token issuance failed')
  mocks.members.mockImplementation(() => { throw new Error('Worker must not read Members') })
  const response = await worker.POST(new Request('https://example.com', { method: 'POST', headers: { Authorization: `Bearer ${issued.value.token}` } }))
  expect(response.status).toBe(204)
  expect(mocks.members).not.toHaveBeenCalled()
})

test.each([spikeStart.POST, spikeResume.POST])('spike routes require Membership in addition to their secret', async handler => {
  vi.stubEnv('SPIKE_SECRET', 'test-spike-secret')
  const incoming = await request()
  incoming.headers.set('x-spike-secret', 'test-spike-secret')
  const response = await handler(incoming)
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'not_member' })
})
