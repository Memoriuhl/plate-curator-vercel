import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SignInForm } from '../components/app/sign-in-form'

const session = vi.hoisted(() => ({ ready: true, signInWithEmail: vi.fn(), signInWithGoogle: vi.fn() }))
vi.mock('../lib/client/session', () => ({ useSession: () => session }))
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
async function check(result: unknown) {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(result))
  render(<SignInForm />)
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
  expect(screen.queryByText(/create account/i)).toBeNull()
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'member@example.com' } })
  fireEvent.submit(screen.getByLabelText('Email').closest('form')!)
  await waitFor(() => expect(screen.queryByLabelText('Email')).toBeNull())
}
test.each(['pending', 'active'])('Google %s Member gets a focused Google button and login hint', async status => {
  await check({ invited: true, signIn: 'google', status })
  const button = screen.getByRole('button', { name: 'Continue with Google' })
  expect(document.activeElement).toBe(button)
  expect(screen.queryByLabelText('Password')).toBeNull()
  fireEvent.submit(button.closest('form')!)
  await waitFor(() => expect(session.signInWithGoogle).toHaveBeenCalledWith('member@example.com'))
})
test('password Member signs in without account creation and sees wrong-password errors', async () => {
  session.signInWithEmail.mockRejectedValueOnce(new Error('auth/invalid-credential'))
  await check({ invited: true, signIn: 'password', status: 'active' })
  const password = screen.getByLabelText('Password')
  expect(document.activeElement).toBe(password)
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
  fireEvent.change(password, { target: { value: 'incorrect' } })
  fireEvent.submit(password.closest('form')!)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Wrong password'))
  expect(session.signInWithEmail).toHaveBeenCalledWith('member@example.com', 'incorrect')
})
test.each([
  [{ invited: false }, 'Plate Curator is invite-only. Ask the Owner for an invite.'],
  [{ invited: true, signIn: 'google', status: 'expired' }, 'Your invite has expired. Ask the Owner for a new one.'],
])('blocked email shows its message and allows changing email', async (result, message) => {
  await check(result)
  expect(screen.getByRole('status').textContent).toBe(message)
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
  expect(session.signInWithGoogle).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Change email' }))
  expect(document.activeElement).toBe(screen.getByLabelText('Email'))
})
test('Google mismatch is announced plainly', async () => {
  const message = "That Google account isn't the invited one. Choose member@example.com in Google's account picker."
  session.signInWithGoogle.mockRejectedValueOnce(new Error(message))
  await check({ invited: true, signIn: 'google', status: 'active' })
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message))
})
