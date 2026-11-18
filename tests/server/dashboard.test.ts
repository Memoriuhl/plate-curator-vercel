import { afterEach, expect, test, vi } from 'vitest'
import { fixtureSource } from '../../lib/catalog/fixture-source'
import type { CuratorState } from '../../lib/catalog/types'

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))
const state = vi.hoisted(() => ({
  version: 11,
  curator: { stateOrder: {}, stateProgress: {} } as CuratorState,
}))
vi.mock('@google-cloud/firestore', () => ({
  Firestore: class {
    /** Resolve the requested document through the Firestore fixture. */
    doc(path: string) {
      return {
        /** Return the fixture catalog pointer or curator document through the expected Firestore path. */ get: async () =>
          path === 'config/catalog'
            ? {
                /** Expose the current fixture catalog version through the pointer's field accessor. */ get: () =>
                  state.version,
              }
            : {
                /** Read detached curator metadata from the simulated Firestore document. */ data: () =>
                  structuredClone(state.curator),
              },
      }
    }
  },
}))
vi.mock('google-auth-library', () => ({
  ExternalAccountClient: {
    /** Build a credential double so snapshot reads can proceed without exchanging a real token. */ fromJSON:
      () => ({
        /** Return the dummy access token expected by the mocked snapshot request. */ getAccessToken:
          async () => ({ token: 'test-token' }),
      }),
  },
}))

const { loadDashboard, loadJurisdiction, loadPlate } =
  await import('../../lib/catalog/dashboard')

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

test('dashboard loaders follow current progress, order and version for summaries, cards and details', async () => {
  for (const name of [
    'GCP_PROJECT_ID',
    'GCP_PROJECT_NUMBER',
    'GCP_WORKLOAD_IDENTITY_POOL_ID',
    'GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID',
    'GCP_SERVICE_ACCOUNT_EMAIL',
    'FIREBASE_STORAGE_BUCKET',
  ]) {
    vi.stubEnv(name, 'test')
  }
  vi.stubEnv('CATALOG_SOURCE', 'firestore')
  vi.stubEnv('PLATE_IMAGE_BASE', '')
  const snapshot = await fixtureSource().readSnapshot()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...snapshot, version: state.version }))
  )
  state.curator = { stateOrder: {}, stateProgress: { AK: 'done' } }
  expect((await loadDashboard()).jurisdictions[0].progress).toBe('done')
  state.curator = {
    stateOrder: { AK: ['AK.amateur_radio_call_sign', 'AK.standard_gold'] },
    stateProgress: { AK: 'needs_ordering' },
  }
  expect((await loadDashboard()).jurisdictions[0].progress).toBe(
    'needs_ordering'
  )
  expect((await loadJurisdiction('AK'))!.plates[0].id).toBe(
    'AK.amateur_radio_call_sign'
  )
  expect((await loadPlate('AK.standard_gold'))!.prevId).toBe(
    'AK.amateur_radio_call_sign'
  )
  expect(await loadJurisdiction('XX')).toBeNull()
  expect(await loadPlate('AK.missing')).toBeNull()
  state.version = 12
  expect((await loadDashboard()).catalogVersion).toBe(12)
})
