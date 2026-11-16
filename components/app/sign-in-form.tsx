'use client'

import { useState, type FormEvent } from 'react'
import { IoLogoGoogle, IoReloadOutline } from 'react-icons/io5'

import { Brand } from './brand'
import { Button } from '@/components/ui/button'
import { useSession } from '@/lib/client/session'

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.includes('not configured')) {
    return 'Sign-in is not configured for this environment yet.'
  }
  return 'We could not sign you in. Check your details and try again.'
}

export function SignInForm() {
  const { ready, signInWithEmail, signInWithGoogle } = useSession()
  const [pending, setPending] = useState<'google' | 'email' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runSignIn(
    kind: 'google' | 'email',
    action: () => Promise<void>,
  ) {
    if (pending || !ready) return
    setPending(kind)
    setError(null)
    try {
      await action()
    } catch (nextError) {
      setError(errorMessage(nextError))
    } finally {
      setPending(null)
    }
  }

  function handleEmailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') || '').trim()
    const password = String(form.get('password') || '')
    void runSignIn('email', () => signInWithEmail(email, password))
  }

  return (
    <section className="sign-in-card" aria-labelledby="sign-in-title">
      <Brand />
      <h1 id="sign-in-title" className="dialog-title">
        Sign in
      </h1>
      <p role={!ready ? 'status' : undefined}>
        {ready
          ? 'Continue with your curator account.'
          : 'Checking your session...'}
      </p>

      <div className="flex flex-col">
        <Button
          variant="primary"
          size="default"
          disabled={!ready || pending !== null}
          onClick={() => void runSignIn('google', signInWithGoogle)}
        >
          {pending === 'google' ? (
            <IoReloadOutline
              data-icon="inline-start"
              aria-hidden
              size={16}
              strokeWidth={1.5}
              className="chrome-icon"
            />
          ) : (
            <IoLogoGoogle data-icon="inline-start" aria-hidden size={16} />
          )}
          {pending === 'google' ? 'Connecting' : 'Continue with Google'}
        </Button>

        <p className="sign-in-divider">or use your email</p>

        <form className="flex flex-col gap-4" onSubmit={handleEmailSubmit}>
          <label
            className="flex flex-col gap-2 text-sm font-semibold text-foreground"
            htmlFor="email"
          >
            Email
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              disabled={!ready || pending !== null}
            />
          </label>

          <label
            className="flex flex-col gap-2 text-sm font-semibold text-foreground"
            htmlFor="password"
          >
            Password
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={!ready || pending !== null}
              placeholder="Your password"
            />
          </label>

          {error ? <p role="alert">{error}</p> : null}

          <Button
            variant="outline"
            size="default"
            type="submit"
            disabled={!ready || pending !== null}
          >
            {pending === 'email' ? (
              <IoReloadOutline
                data-icon="inline-start"
                aria-hidden
                size={16}
                strokeWidth={1.5}
                className="chrome-icon"
              />
            ) : null}
            {pending === 'email' ? 'Signing in' : 'Sign in with email'}
          </Button>
        </form>
      </div>
    </section>
  )
}
