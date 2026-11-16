import { afterEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cachedJurisdiction: vi.fn(),
  loadSnapshot: vi.fn(() => { throw new Error('Full snapshot reads are unavailable') }),
  readSnapshot: vi.fn(() => { throw new Error('Full snapshot reads are unavailable') }),
  readCuratorState: vi.fn(async () => ({ stateOrder: { AK: ['AK.two', 'AK.one'] }, stateProgress: {} })),
}))
vi.mock('server-only', () => ({}))
vi.mock('../../lib/server/snapshot-cache', () => ({ cachedJurisdiction: mocks.cachedJurisdiction }))
vi.mock('../../lib/gcp/storage', () => ({ loadSnapshot: mocks.loadSnapshot }))
vi.mock('../../lib/gcp/firestore', () => ({ stagingFirestore: () => ({}) }))
vi.mock('../../lib/review/firestore-store', () => ({ firestoreReviewStore: () => ({}) }))
vi.mock('../../lib/catalog/firestore-source', () => ({ firestoreCatalogSource: () => mocks }))
vi.mock('../../lib/catalog/fixture-source', () => ({ fixtureSource: () => mocks }))

const { reviewDeps } = await import('../../lib/server/context')

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
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
