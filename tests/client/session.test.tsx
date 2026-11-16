import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SessionProvider, useSession } from '../../lib/client/session'
import { useEffect } from 'react'

const mocks = vi.hoisted(() => ({
  listener: null as null | ((user: unknown) => void),
  popup: vi.fn(), signOut: vi.fn(), parameters: vi.fn(), create: vi.fn(),
}))
vi.mock('../../lib/client/firebase', () => ({ clientAuth: () => ({ currentUser: null }) }))
vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: class { setCustomParameters = mocks.parameters },
  onIdTokenChanged: (_auth: unknown, callback: (user: unknown) => void) => { mocks.listener = callback; callback(null); return () => {} },
  signInWithPopup: mocks.popup, signOut: mocks.signOut,
  signInWithEmailAndPassword: vi.fn(), createUserWithEmailAndPassword: mocks.create,
}))
let session: ReturnType<typeof useSession>
function Probe() {
  const current = useSession()
  useEffect(() => { session = current }, [current])
  return <p>{current.user?.email ?? 'signed out'}</p>
}
beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)
test('mismatched Google account signs out before exposing a signed-in session', async () => {
  render(<SessionProvider><Probe /></SessionProvider>)
  mocks.popup.mockImplementationOnce(async () => {
    const user = { email: 'other@example.com', uid: 'other' }
    mocks.listener?.(user)
    return { user }
  })
  await act(async () => {
    await expect(session.signInWithGoogle('member@example.com')).rejects.toThrow("That Google account isn't the invited one. Choose member@example.com in Google's account picker.")
  })
  expect(mocks.parameters).toHaveBeenCalledWith({ login_hint: 'member@example.com' })
  expect(mocks.signOut).toHaveBeenCalledOnce()
  expect(screen.getByText('signed out')).toBeDefined()
})
test('matching Google email is normalized and exposes the signed-in session', async () => {
  render(<SessionProvider><Probe /></SessionProvider>)
  mocks.popup.mockResolvedValueOnce({ user: { email: 'MEMBER@example.com', uid: 'member' } })
  await act(async () => session.signInWithGoogle('member@example.com'))
  await waitFor(() => expect(screen.getByText('MEMBER@example.com')).toBeDefined())
  expect(mocks.signOut).not.toHaveBeenCalled()
})
