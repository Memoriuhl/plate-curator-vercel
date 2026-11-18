import { afterEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getByUid: vi.fn(),
  resumeHook: vi.fn(async () => ({})),
  cachedJurisdiction: vi.fn(),
  loadSnapshot: vi.fn(() => { throw new Error('Full snapshot reads are unavailable') }),
  readSnapshot: vi.fn(() => { throw new Error('Full snapshot reads are unavailable') }),
  readCuratorState: vi.fn(async () => ({ stateOrder: { AK: ['AK.two', 'AK.one'] }, stateProgress: {} })),
  imageUrl: vi.fn((plate: { image: string; imageUrl?: string }) => plate.imageUrl ?? `https://assets.example/plates/${plate.image}`),
}))
vi.mock('workflow/api', () => ({ resumeHook: mocks.resumeHook }))
vi.mock('server-only', () => ({}))
vi.mock('../../lib/auth/actor', () => ({ authenticate: mocks.authenticate, /** Leave the environment owner allowlist empty so the test checks stored membership. */ parseOwnerUids: () => [] }))
vi.mock('../../lib/server/members', () => ({ /** Expose the fixture member lookup used to resolve current server owner access. */ membersStore: () => ({ getByUid: mocks.getByUid }) }))
vi.mock('../../lib/server/snapshot-cache', () => ({ cachedJurisdiction: mocks.cachedJurisdiction }))
vi.mock('../../lib/gcp/storage', () => ({ loadSnapshot: mocks.loadSnapshot }))
vi.mock('../../lib/gcp/firestore', () => ({ /** Omit the real staging client because the test supplies its member and catalog adapters. */ stagingFirestore: () => ({}) }))
vi.mock('../../lib/review/firestore-store', () => ({ /** Return a placeholder review store while testing how server context selects its dependencies. */ firestoreReviewStore: () => ({}) }))
vi.mock('../../lib/catalog/firestore-source', () => ({ /** Provide the controlled live catalog reader when the context selects Firestore. */ firestoreCatalogSource: () => mocks }))
vi.mock('../../lib/catalog/fixture-source', () => ({ /** Provide the same controlled catalog reader when the context selects fixtures. */ fixtureSource: () => mocks }))
vi.mock('../../lib/jobs/firestore-store', () => ({ /** Give the server context a deterministic jobs environment for dependency assertions. */ firestoreJobsStore: () => ({ env: 'development' }) }))

const { reviewDeps, catalogPushDeps, currentActiveOwner, hostedTaggingDeps } = await import('../../lib/server/context')

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

test('catalog push is disabled by default and requires staging when enabled', async () => {
  vi.stubEnv('CATALOG_PUSH_ENABLED', '')
  vi.stubEnv('GCP_PROJECT_ID', '')
  expect(catalogPushDeps().enabled).toBe(false)
  vi.stubEnv('CATALOG_PUSH_ENABLED', 'true')
  expect(() => catalogPushDeps()).toThrow('Catalog push requires staging')
  vi.stubEnv('GCP_PROJECT_ID', 'license-plate-game-staging')
  vi.stubEnv('EXPO_ACCESS_TOKEN', '')
  expect(() => catalogPushDeps()).toThrow('Missing environment variable EXPO_ACCESS_TOKEN')
  vi.stubEnv('EXPO_ACCESS_TOKEN', 'test')
  expect(catalogPushDeps().enabled).toBe(true)
})

test.each(['fixture', 'firestore'])('state baseline orders the cached jurisdiction at the pinned version for %s', async kind => {
  vi.stubEnv('CATALOG_SOURCE', kind)
  vi.stubEnv('VERCEL_ENV', 'development')
  const plates = ['AK.one', 'AK.two'].map(id => ({ id, state: 'AK', slug: id, displayName: id, tags: [], image: '' }))
  mocks.cachedJurisdiction.mockResolvedValue({ version: 7, plates })
  expect(await reviewDeps().stateBaseline(7, 'AK')).toEqual([plates[1], plates[0]])
  expect(mocks.cachedJurisdiction).toHaveBeenCalledExactlyOnceWith(7, 'AK', kind)
  expect(mocks.readCuratorState).toHaveBeenCalledOnce()
  expect(mocks.loadSnapshot).not.toHaveBeenCalled()
  expect(mocks.readSnapshot).not.toHaveBeenCalled()
})

test.each(['submitted', 'approved'] as const)('superseding %s wakes both hooks across an approval transition', async state => {
  await reviewDeps().supersedeRun?.({ id: 'batch', name: '', createdBy: 'editor', createdByName: null, createdAt: '', state, revision: state === 'submitted' ? 4 : 5, baselineVersion: 7, stateOrders: {}, plateIds: [], approval: null, approvalRun: { runId: 'run', revision: 4 } })
  expect(mocks.resumeHook).toHaveBeenCalledWith('approval:batch:4', { superseded: true })
  expect(mocks.resumeHook).toHaveBeenCalledWith('publish:batch:5', { superseded: true })
})

test.each(['fixture', 'firestore'])('versioned plate baselines use the immutable jurisdiction for %s', async kind => {
  vi.stubEnv('CATALOG_SOURCE', kind)
  vi.stubEnv('VERCEL_ENV', 'development')
  const plate = { id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', tags: [], image: '' }
  mocks.cachedJurisdiction.mockResolvedValue({ version: 7, plates: [plate] })
  expect(await reviewDeps().baselineAtVersion(7, plate.id)).toEqual(plate)
  expect(mocks.cachedJurisdiction).toHaveBeenCalledExactlyOnceWith(7, 'AK', kind)
  expect(mocks.readSnapshot).not.toHaveBeenCalled()
  expect(mocks.readCuratorState).not.toHaveBeenCalled()
  expect(await reviewDeps().baselineAtVersion(7, 'AK.missing')).toBeNull()
  mocks.cachedJurisdiction.mockResolvedValue({ version: 8, plates: [plate] })
  await expect(reviewDeps().baselineAtVersion(7, plate.id)).rejects.toThrow('Baseline catalog version unavailable')
})

test('snapshot state baselines ignore curator order and sort the pinned plates by sortOrder', async () => {
  vi.stubEnv('CATALOG_SOURCE', 'fixture')
  vi.stubEnv('VERCEL_ENV', 'development')
  const plates = ['AK.three', 'AK.two', 'AK.one'].map((id, index) => ({ id, state: 'AK', sortOrder: 3 - index }))
  mocks.cachedJurisdiction.mockResolvedValue({ version: 7, plates })
  expect(await reviewDeps().stateBaseline(7, 'AK', 'snapshot')).toEqual([...plates].reverse())
  expect(mocks.cachedJurisdiction).toHaveBeenCalledExactlyOnceWith(7, 'AK', 'fixture')
  expect(mocks.readCuratorState).not.toHaveBeenCalled()
})

test('active Owner helper returns authenticated identity and current membership email', async () => {
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'demo-plate-curator')
  vi.stubEnv('CATALOG_SOURCE', 'firestore')
  mocks.authenticate.mockResolvedValue({ ok: true, actor: { uid: 'owner', role: 'owner', name: null } })
  mocks.getByUid.mockResolvedValue({ uid: 'owner', role: 'owner', status: 'active', email: 'owner@example.com' })
  expect(await currentActiveOwner(new Request('http://localhost'))).toEqual({ ok: true, actor: { uid: 'owner', role: 'owner', name: null, email: 'owner@example.com', authorityEpoch: 0 } })
  for (const member of [null, { uid: 'owner', role: 'editor', status: 'active' }, { uid: 'owner', role: 'owner', status: 'pending' }]) {
    mocks.getByUid.mockResolvedValue(member)
    const result = await currentActiveOwner(new Request('http://localhost'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(403)
  }
  const response = Response.json({ error: 'unauthenticated' }, { status: 401 })
  mocks.getByUid.mockClear()
  mocks.authenticate.mockResolvedValue({ ok: false, response })
  expect(await currentActiveOwner(new Request('http://localhost'))).toEqual({ ok: false, response })
  expect(mocks.getByUid).not.toHaveBeenCalled()
  mocks.authenticate.mockResolvedValue({ ok: true, actor: { uid: 'editor', role: 'editor', name: null } })
  const editor = await currentActiveOwner(new Request('http://localhost'))
  expect(editor.ok).toBe(false)
  if (!editor.ok) expect(editor.response.status).toBe(403)
  expect(mocks.getByUid).not.toHaveBeenCalled()
})

test.each(['0', '1'])('hosted tagging preserves catalog image behavior outside local mode %s', async local => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', local)
  vi.stubEnv('LOCAL_PIPELINE_SCOPE', 'scope')
  vi.stubEnv('AI_GATEWAY_API_KEY', 'fixture')
  vi.stubEnv('CATALOG_SOURCE', 'fixture')
  vi.stubEnv('VERCEL_ENV', 'development')
  const deps = await hostedTaggingDeps('gateway-gemma4-26b')
  const inputPlate = { id: 'AK.a', state: 'AK', slug: 'a', displayName: 'A', tags: [], image: 'AK/a.webp', imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Override.jpg' }
  const value = await deps.plate({ id: 'hosted', batchId: 'batch', plateId: inputPlate.id, requestedBy: 'editor', inputHash: 'base', env: 'development', createdAt: 0, state: 'queued', inputPlate })
  expect(value?.imageUrl).toBe(local === '1' ? 'https://assets.example/plates/AK/a.webp' : inputPlate.imageUrl)
  expect(mocks.imageUrl).toHaveBeenLastCalledWith(local === '1' ? { ...inputPlate, imageUrl: undefined } : inputPlate)
})
