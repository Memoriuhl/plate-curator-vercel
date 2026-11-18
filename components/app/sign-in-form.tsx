'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { IoLogoGoogle } from 'react-icons/io5'
import { Brand } from './brand'
import { Button } from '@/components/ui/button'
import { useSession } from '@/lib/client/session'

type Check =
  | { invited: false }
  | {
      invited: true
      signIn: 'google' | 'password'
      status: 'pending' | 'active' | 'expired'
    }

/** Translate provider and membership failures into actionable sign-in messages. */
function errorMessage(error: unknown) {
  if (error instanceof Error) {
    if (error.message.includes('not configured'))
      return 'Sign-in is not configured for this environment yet.'
    if (error.message.startsWith("That Google account isn't"))
      return error.message
    if (/auth\/(wrong-password|invalid-credential)/.test(error.message))
      return 'Wrong password. Check your password and try again.'
  }
  return 'We could not sign you in. Check your details and try again.'
}

/**
 * Render the curator sign-in options and keep keyboard focus usable through failed
 * attempts.
 */
export function SignInForm() {
  const { ready, signInWithEmail, signInWithGoogle } = useSession()
  const [email, setEmail] = useState('')
  const [check, setCheck] = useState<Check | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const emailControl = useRef<HTMLInputElement>(null)
  const passwordControl = useRef<HTMLInputElement>(null)
  const googleControl = useRef<HTMLButtonElement>(null)
  const changeControl = useRef<HTMLButtonElement>(null)
  const focusedStep = useRef<Check | null | undefined>(undefined)
  const submitFocus = useRef<{ step: Check | null; failed: boolean } | null>(
    null
  )

  useEffect(() => {
    /** Stop pending focus restoration if the user has moved on to another control. */
    function cancelRestore(event: FocusEvent) {
      if (
        event.target instanceof HTMLElement &&
        event.target !== document.body &&
        !event.target.matches(':disabled')
      ) {
        submitFocus.current = null
      }
    }
    document.addEventListener('focusin', cancelRestore)
    return () => document.removeEventListener('focusin', cancelRestore)
  }, [])

  useEffect(() => {
    const sameStep = focusedStep.current === check
    const restore =
      submitFocus.current?.failed &&
      submitFocus.current.step === check &&
      !pending
    if (sameStep && !restore) return
    const control = !check
      ? emailControl.current
      : !check.invited || check.status === 'expired'
        ? changeControl.current
        : check.signIn === 'password'
          ? passwordControl.current
          : googleControl.current
    if (!control || control.disabled) return
    submitFocus.current = null
    if (
      sameStep &&
      document.activeElement &&
      document.activeElement !== document.body
    )
      return
    control.focus()
    focusedStep.current = check
  }, [check, error, pending, ready])

  /**
   * Choose sign-in or registration for the submitted email and report the resulting
   * outcome.
   */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || !ready) return
    const password = new FormData(event.currentTarget).get('password')
    const active = document.activeElement
    const attempt =
      (active instanceof HTMLInputElement ||
        active instanceof HTMLButtonElement) &&
      event.currentTarget.contains(active) &&
      !active.disabled
        ? { step: check, failed: false }
        : null
    submitFocus.current = attempt
    setPending(true)
    setError(null)
    try {
      if (!check) {
        const response = await fetch('/api/sign-in/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim() }),
          // Recheck invitation eligibility each time sign-in starts.
          cache: 'no-store',
        })
        if (!response.ok) throw new Error('Email check failed')
        setEmail(email.trim())
        setCheck(await response.json())
      } else if (check.invited && check.status !== 'expired') {
        if (check.signIn === 'google') await signInWithGoogle(email)
        else await signInWithEmail(email, String(password ?? ''))
      }
      submitFocus.current = null
    } catch (nextError) {
      if (attempt && submitFocus.current === attempt) attempt.failed = true
      setError(errorMessage(nextError))
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="sign-in-card" aria-labelledby="sign-in-title">
      <Brand />
      <h1 id="sign-in-title" className="dialog-title">
        Sign in
      </h1>
      <p>{check ? email : 'Enter your email to continue to Plate Curator.'}</p>
      <form
        className="flex flex-col gap-4"
        onSubmit={submit}
        aria-busy={pending}
      >
        {!check ? (
          <>
            <label
              className="flex flex-col gap-2 text-sm font-semibold text-foreground"
              htmlFor="email"
            >
              Email
              <input
                key="email"
                ref={emailControl}
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={pending}
              />
            </label>
            <Button type="submit" disabled={!ready || pending}>
              {pending ? 'Checking' : 'Continue'}
            </Button>
          </>
        ) : !check.invited ? (
          <p role="status">
            Plate Curator is invite-only. Ask the Owner for an invite.
          </p>
        ) : check.status === 'expired' ? (
          <p role="status">
            Your invite has expired. Ask the Owner for a new one.
          </p>
        ) : check.signIn === 'google' ? (
          <Button
            ref={googleControl}
            type="submit"
            disabled={!ready || pending}
          >
            <IoLogoGoogle data-icon="inline-start" aria-hidden size={16} />
            {pending ? 'Connecting' : 'Continue with Google'}
          </Button>
        ) : (
          <>
            <label
              className="flex flex-col gap-2 text-sm font-semibold text-foreground"
              htmlFor="password"
            >
              Password
              <input
                key="password"
                ref={passwordControl}
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={pending}
              />
            </label>
            <Button type="submit" disabled={!ready || pending}>
              {pending ? 'Signing in' : 'Sign in'}
            </Button>
          </>
        )}
        <div aria-live="polite">
          {error ? <p role="alert">{error}</p> : null}
        </div>
        {check ? (
          <Button
            ref={changeControl}
            variant="ghost"
            type="button"
            disabled={pending}
            onClick={() => {
              setCheck(null)
              setError(null)
            }}
          >
            Change email
          </Button>
        ) : null}
      </form>
    </section>
  )
}
