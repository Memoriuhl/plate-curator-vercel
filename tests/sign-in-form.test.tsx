import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Profiler, type SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SignInForm } from '../components/app/sign-in-form'

const session = vi.hoisted(() => ({ ready: true, signInWithEmail: vi.fn(), signInWithGoogle: vi.fn() }))
const focusTiming = vi.hoisted(() => ({ splitCheck: false }))
vi.mock('react', async load => {
  const actual = await load<typeof import('react')>()
  return {
    ...actual,
    useState<T>(initial: T | (() => T)) {
      const [value, setValue] = actual.useState(initial)
      return [value, (next: SetStateAction<T>) => {
        if (focusTiming.splitCheck && next !== null && typeof next === 'object' && 'invited' in next) {
          flushSync(() => setValue(next))
        } else setValue(next)
      }]
    },
  }
})
vi.mock('../lib/client/session', () => ({ useSession: () => session }))
beforeEach(() => { focusTiming.splitCheck = false; session.ready = true; vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn()) })
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
  await waitFor(() => expect(document.activeElement).toBe(button))
  expect(screen.queryByLabelText('Password')).toBeNull()
  fireEvent.submit(button.closest('form')!)
  await waitFor(() => expect(session.signInWithGoogle).toHaveBeenCalledWith('member@example.com'))
})
test('password Member signs in without account creation and sees wrong-password errors', async () => {
  session.signInWithEmail.mockRejectedValueOnce(new Error('auth/invalid-credential'))
  await check({ invited: true, signIn: 'password', status: 'active' })
  const password = screen.getByLabelText('Password')
  await waitFor(() => expect(document.activeElement).toBe(password))
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
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Email')))
})
test('Google mismatch is announced plainly', async () => {
  const message = "That Google account isn't the invited one. Choose member@example.com in Google's account picker."
  session.signInWithGoogle.mockRejectedValueOnce(new Error(message))
  await check({ invited: true, signIn: 'google', status: 'active' })
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message))
})

test.each(['password', 'google'] as const)('%s control receives focus when the email result commits before pending clears', async signIn => {
  focusTiming.splitCheck = true
  const commits: { disabled: boolean; busy: string | null }[] = []
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ invited: true, signIn, status: 'active' }))
  render(<Profiler id="sign-in" onRender={() => {
    if (document.getElementById('email')) return
    const control = document.querySelector<HTMLInputElement | HTMLButtonElement>(signIn === 'password' ? '#password' : 'button[type="submit"]')
    if (control) commits.push({ disabled: control.disabled, busy: control.closest('form')!.getAttribute('aria-busy') })
  }}><SignInForm /></Profiler>)
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'member@example.com' } })
  await act(async () => { fireEvent.submit(screen.getByLabelText('Email').closest('form')!) })
  const control = signIn === 'password' ? screen.getByLabelText('Password') : screen.getByRole('button', { name: 'Continue with Google' })
  expect(commits).toContainEqual({ disabled: true, busy: 'true' })
  expect((control as HTMLInputElement | HTMLButtonElement).disabled).toBe(false)
  expect(document.activeElement).toBe(control)
})

test('Google focus waits for session readiness and leaves later focus changes alone', async () => {
  let finishCheck!: (response: Response) => void
  vi.mocked(fetch).mockReturnValueOnce(new Promise(resolve => { finishCheck = resolve }))
  const view = render(<SignInForm />)
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'member@example.com' } })
  fireEvent.submit(screen.getByLabelText('Email').closest('form')!)
  session.ready = false
  await act(async () => { finishCheck(Response.json({ invited: true, signIn: 'google', status: 'active' })) })
  const button = screen.getByRole('button', { name: 'Continue with Google' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  session.ready = true
  view.rerender(<SignInForm />)
  expect(document.activeElement).toBe(button)
  const change = screen.getByRole('button', { name: 'Change email' })
  change.focus()
  for (const ready of [false, true]) {
    session.ready = ready
    view.rerender(<SignInForm />)
    expect(document.activeElement).toBe(change)
  }
})
