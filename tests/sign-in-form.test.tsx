import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Profiler, type SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SignInForm } from '../components/app/sign-in-form'

const session = vi.hoisted(() => ({ ready: true, signInWithEmail: vi.fn(), signInWithGoogle: vi.fn() }))
const focusTiming = vi.hoisted(() => ({ splitCheck: false, splitError: false }))
vi.mock('react', async load => {
  const actual = await load<typeof import('react')>()
  return {
    ...actual,
    /**
     * Record state changes tied to failed submission focus while preserving React's
     * state behavior.
     */
    useState<T>(initial: T | (() => T)) {
      const [value, setValue] = actual.useState(initial)
      return [value, (next: SetStateAction<T>) => {
        if ((focusTiming.splitCheck && next !== null && typeof next === 'object' && 'invited' in next)
          || (focusTiming.splitError && typeof next === 'string' && next.includes('try again'))) {
          flushSync(() => setValue(next))
        } else setValue(next)
      }]
    },
  }
})
vi.mock('../lib/client/session', () => ({ /** Supply the fixture session and API client to the component under test. */ useSession: () => session }))
beforeEach(() => { focusTiming.splitCheck = false; focusTiming.splitError = false; session.ready = true; vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
/**
 * Exercise an email invitation check with the supplied response and assert the resulting
 * form.
 */
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

/** Create a promise that the test can settle after observing pending form behavior. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Simulate the focus loss that can occur when the submitted control becomes disabled. */
function simulateBrowserDisabledBlur(control: HTMLInputElement | HTMLButtonElement) {
  expect(control.disabled).toBe(true)
  control.disabled = false
  control.blur()
  control.disabled = true
  expect(document.activeElement).toBe(document.body)
}

/** Start a controlled submission and expose its pending request and focus target. */
async function pendingSubmit(step: 'email' | 'password' | 'google', commits: { disabled: boolean; busy: string | null }[] = []) {
  const request = deferred<Response>()
  if (step !== 'email') vi.mocked(fetch).mockResolvedValueOnce(Response.json({ invited: true, signIn: step, status: 'active' }))
  const view = render(<SignInForm />, { /** Observe the form commit that clears busy state so focus assertions can run at the right moment. */ wrapper: ({ children }) => <Profiler id="failed-submit" onRender={() => {
    if (!screen.queryByRole('alert')) return
    const control = document.querySelector<HTMLInputElement | HTMLButtonElement>(step === 'email' ? '#email' : step === 'password' ? '#password' : 'button[type="submit"]')
    if (control) commits.push({ disabled: control.disabled, busy: control.closest('form')!.getAttribute('aria-busy') })
  }}>{children}</Profiler> })
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'member@example.com' } })
  if (step === 'email') {
    vi.mocked(fetch).mockReturnValueOnce(request.promise)
  } else {
    await act(async () => { fireEvent.submit(screen.getByLabelText('Email').closest('form')!) })
    if (step === 'password') session.signInWithEmail.mockReturnValueOnce(request.promise)
    else session.signInWithGoogle.mockReturnValueOnce(request.promise)
  }
  const control = (step === 'google' ? screen.getByRole('button', { name: 'Continue with Google' })
    : screen.getByLabelText(step === 'email' ? 'Email' : 'Password')) as HTMLInputElement | HTMLButtonElement
  expect(document.activeElement).toBe(control)
  fireEvent.submit(control.closest('form')!)
  simulateBrowserDisabledBlur(control)
  return { request, control, view }
}

test.each([
  ['email', false], ['email', true],
  ['password', false], ['password', true],
  ['google', false], ['google', true],
] as const)('%s failure restores focus once with split error commit %s', async (step, splitError) => {
  const commits: { disabled: boolean; busy: string | null }[] = []
  const { request, control } = await pendingSubmit(step, commits)
  focusTiming.splitError = splitError
  const focus = vi.spyOn(control, 'focus')
  await act(async () => {
    if (step === 'email') request.resolve(new Response(null, { status: 500 }))
    else request.reject(new Error(step === 'password' ? 'auth/invalid-credential' : 'Google unavailable'))
  })
  expect(screen.getByRole('alert').textContent).toContain(step === 'password' ? 'Wrong password' : 'We could not sign you in')
  expect(control.disabled).toBe(false)
  expect(document.activeElement).toBe(control)
  expect(focus).toHaveBeenCalledTimes(1)
  if (splitError) expect(commits).toContainEqual({ disabled: true, busy: 'true' })
  expect(commits).toContainEqual({ disabled: false, busy: 'false' })
  focus.mockRestore()
})

test.each([
  ['email', false], ['email', true],
  ['password', false], ['password', true],
  ['google', false], ['google', true],
] as const)('%s failure preserves a deliberate focus move, then blur %s', async (step, blur) => {
  const { request, control } = await pendingSubmit(step)
  const outside = document.createElement('button')
  document.body.append(outside)
  try {
    outside.focus()
    if (blur) outside.blur()
    const focus = vi.spyOn(control, 'focus')
    await act(async () => { request.reject(new Error('auth/invalid-credential')) })
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(document.activeElement).toBe(blur ? document.body : outside)
    expect(focus).not.toHaveBeenCalled()
    focus.mockRestore()
  } finally {
    outside.remove()
  }
})

test.each(['password', 'google'] as const)('%s success does not restore lost focus', async step => {
  const { request, control } = await pendingSubmit(step)
  const focus = vi.spyOn(control, 'focus')
  await act(async () => { request.resolve(Response.json({})) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(control.disabled).toBe(false)
  expect(document.activeElement).toBe(document.body)
  expect(focus).not.toHaveBeenCalled()
  focus.mockRestore()
})

test('a Google failure waits for readiness and does not refocus on later ready or pending changes', async () => {
  const { request, control, view } = await pendingSubmit('google')
  session.ready = false
  const focus = vi.spyOn(control, 'focus')
  await act(async () => { request.reject(new Error('Google unavailable')) })
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(control.disabled).toBe(true)
  expect(document.activeElement).toBe(document.body)
  expect(focus).not.toHaveBeenCalled()
  session.ready = true
  view.rerender(<SignInForm />)
  expect(document.activeElement).toBe(control)
  expect(focus).toHaveBeenCalledTimes(1)
  const change = screen.getByRole('button', { name: 'Change email' })
  change.focus()
  for (const ready of [false, true]) {
    session.ready = ready
    view.rerender(<SignInForm />)
    expect(document.activeElement).toBe(change)
    expect(focus).toHaveBeenCalledTimes(1)
  }
  const success = deferred<void>()
  session.signInWithGoogle.mockReturnValueOnce(success.promise)
  fireEvent.submit(control.closest('form')!)
  simulateBrowserDisabledBlur(change as HTMLButtonElement)
  await act(async () => { success.resolve() })
  expect(control.disabled).toBe(false)
  expect(document.activeElement).toBe(document.body)
  expect(focus).toHaveBeenCalledTimes(1)
  focus.mockRestore()
})

test('a focus move while a failed Google submit waits for readiness cancels restoration', async () => {
  const { request, control, view } = await pendingSubmit('google')
  session.ready = false
  await act(async () => { request.reject(new Error('Google unavailable')) })
  const change = screen.getByRole('button', { name: 'Change email' })
  change.focus()
  change.blur()
  session.ready = true
  const focus = vi.spyOn(control, 'focus')
  view.rerender(<SignInForm />)
  expect(control.disabled).toBe(false)
  expect(document.activeElement).toBe(document.body)
  expect(focus).not.toHaveBeenCalled()
  focus.mockRestore()
})

test('an email failure cannot restore focus that the submit did not disable', async () => {
  const request = deferred<Response>()
  vi.mocked(fetch).mockReturnValueOnce(request.promise)
  render(<SignInForm />)
  const email = screen.getByLabelText('Email')
  const brand = screen.getByRole('link')
  brand.focus()
  fireEvent.submit(email.closest('form')!)
  brand.blur()
  const focus = vi.spyOn(email, 'focus')
  await act(async () => { request.reject(new Error('Email check failed')) })
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(document.body)
  expect(focus).not.toHaveBeenCalled()
  focus.mockRestore()
})

test('a focused Sign in button losing focus restores the password for each failed attempt', async () => {
  await check({ invited: true, signIn: 'password', status: 'active' })
  const password = screen.getByLabelText('Password')
  const button = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement
  const focus = vi.spyOn(password, 'focus')
  for (const count of [1, 2]) {
    const request = deferred<void>()
    session.signInWithEmail.mockReturnValueOnce(request.promise)
    button.focus()
    fireEvent.submit(button.closest('form')!)
    simulateBrowserDisabledBlur(button)
    await act(async () => { request.reject(new Error('auth/invalid-credential')) })
    expect(document.activeElement).toBe(password)
    expect(focus).toHaveBeenCalledTimes(count)
  }
  focus.mockRestore()
})
