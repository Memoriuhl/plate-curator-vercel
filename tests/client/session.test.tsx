import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SessionProvider, useSession } from '../../lib/client/session'
import { useEffect } from 'react'

const mocks = vi.hoisted(() => ({
  listener: null as null | ((user: unknown) => void),
  popup: vi.fn(),
  signOut: vi.fn(),
  parameters: vi.fn(),
  create: vi.fn(),
  auth: vi.fn(),
  unsubscribe: vi.fn(),
  listenerError: null as null | (() => void),
}))
vi.mock('../../lib/client/firebase', () => ({ clientAuth: mocks.auth }))
vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: class {
    setCustomParameters = mocks.parameters
  },
  /**
   * Capture the Firebase authentication listener so tests can emit user changes and
   * inspect cleanup.
   */
  onIdTokenChanged: (
    _auth: unknown,
    callback: (user: unknown) => void,
    onError: () => void
  ) => {
    mocks.listener = callback
    mocks.listenerError = onError
    callback(null)
    return mocks.unsubscribe
  },
  signInWithPopup: mocks.popup,
  signOut: mocks.signOut,
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: mocks.create,
}))
let session: ReturnType<typeof useSession>
/**
 * Expose the active session state to the hook test while rendering the current user
 * identity.
 */
function Probe() {
  const current = useSession()
  useEffect(() => {
    session = current
  }, [current])
  return <p>{current.user?.email ?? 'signed out'}</p>
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockReset().mockReturnValue({ currentUser: null })
  mocks.listener = null
  mocks.listenerError = null
})
afterEach(cleanup)
test('missing configuration renders an actionable fallback without exposing children', () => {
  mocks.auth.mockImplementation(() => {
    throw new Error('Firebase sign-in is not configured')
  })
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>
  )
  expect(screen.getByRole('alert').textContent).toContain(
    'NEXT_PUBLIC_FIREBASE_*'
  )
  expect(screen.queryByText('signed out')).toBeNull()
  expect(mocks.listener).toBeNull()
})
test('invalid API keys do not escape the session effect', () => {
  mocks.auth.mockImplementation(() => {
    throw new Error('Firebase: Error (auth/invalid-api-key).')
  })
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>
  )
  expect(
    screen.getByRole('heading', { name: 'Sign-in unavailable' })
  ).toBeDefined()
})
test('observer errors fail closed and clean up on unmount', () => {
  const view = render(
    <SessionProvider>
      <Probe />
    </SessionProvider>
  )
  expect(session.ready).toBe(true)
  act(() => mocks.listenerError?.())
  expect(screen.getByRole('alert')).toBeDefined()
  expect(screen.queryByText('signed out')).toBeNull()
  view.unmount()
  expect(mocks.unsubscribe).toHaveBeenCalledOnce()
})
test('mismatched Google account signs out before exposing a signed-in session', async () => {
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>
  )
  mocks.popup.mockImplementationOnce(async () => {
    const user = { email: 'other@example.com', uid: 'other' }
    mocks.listener?.(user)
    return { user }
  })
  await act(async () => {
    await expect(
      session.signInWithGoogle('member@example.com')
    ).rejects.toThrow(
      "That Google account isn't the invited one. Choose member@example.com in Google's account picker."
    )
  })
  expect(mocks.parameters).toHaveBeenCalledWith({
    login_hint: 'member@example.com',
  })
  expect(mocks.signOut).toHaveBeenCalledOnce()
  expect(screen.getByText('signed out')).toBeDefined()
})
test('matching Google email is normalized and exposes the signed-in session', async () => {
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>
  )
  mocks.popup.mockResolvedValueOnce({
    user: { email: 'MEMBER@example.com', uid: 'member' },
  })
  await act(async () => session.signInWithGoogle('member@example.com'))
  await waitFor(() =>
    expect(screen.getByText('MEMBER@example.com')).toBeDefined()
  )
  expect(mocks.signOut).not.toHaveBeenCalled()
})
