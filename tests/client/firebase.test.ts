import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { clientApp, clientAuth } from '../../lib/client/firebase'

const mocks = vi.hoisted(() => ({
  apps: vi.fn(),
  initialize: vi.fn(),
  auth: vi.fn(),
  connectAuth: vi.fn(),
}))
vi.mock('firebase/app', () => ({
  getApps: mocks.apps,
  initializeApp: mocks.initialize,
}))
vi.mock('firebase/auth', () => ({
  getAuth: mocks.auth,
  connectAuthEmulator: mocks.connectAuth,
}))

const variables = {
  NEXT_PUBLIC_FIREBASE_API_KEY: 'test-api-key',
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'test.firebaseapp.com',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'test',
  NEXT_PUBLIC_FIREBASE_APP_ID: 'test-app',
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.apps.mockReturnValue([])
  for (const [name, value] of Object.entries(variables)) vi.stubEnv(name, value)
})
afterEach(() => vi.unstubAllEnvs())

test.each(Object.keys(variables))(
  'rejects missing %s before initializing Firebase',
  (name) => {
    vi.stubEnv(name, '')
    expect(() => clientAuth()).toThrow('Firebase sign-in is not configured')
    expect(mocks.initialize).not.toHaveBeenCalled()
    expect(mocks.auth).not.toHaveBeenCalled()
  }
)

test('rejects whitespace-only configuration', () => {
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', '  ')
  expect(() => clientApp()).toThrow('Firebase sign-in is not configured')
  expect(mocks.initialize).not.toHaveBeenCalled()
})

test('normalizes configuration and initializes authentication', () => {
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', ' test-api-key ')
  const app = { name: '[DEFAULT]' }
  mocks.initialize.mockReturnValue(app)
  clientAuth()
  expect(mocks.initialize).toHaveBeenCalledWith({
    apiKey: 'test-api-key',
    authDomain: 'test.firebaseapp.com',
    projectId: 'test',
    appId: 'test-app',
  })
  expect(mocks.auth).toHaveBeenCalledWith(app)
})

test('reuses the default app rather than an unrelated named app', () => {
  const app = { name: '[DEFAULT]' }
  mocks.apps.mockReturnValue([{ name: 'secondary' }, app])
  expect(clientApp()).toBe(app)
  expect(mocks.initialize).not.toHaveBeenCalled()
})

test('connects Auth to the local emulator only for a demo project', () => {
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST', 'localhost:9185')
  const app = { name: '[DEFAULT]' }
  mocks.apps.mockReturnValue([app])
  const auth = {}
  mocks.auth.mockReturnValue(auth)
  clientAuth()
  expect(mocks.connectAuth).not.toHaveBeenCalled()

  vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'demo-plate-curator')
  clientAuth()
  clientAuth()
  expect(mocks.connectAuth).toHaveBeenCalledTimes(1)
  expect(mocks.connectAuth).toHaveBeenCalledWith(
    auth,
    'http://localhost:9185',
    { disableWarnings: true }
  )
})
