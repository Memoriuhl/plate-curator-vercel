'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { IoLogoGoogle } from 'react-icons/io5'
import { Brand } from './brand'
import { Button } from '@/components/ui/button'
import { useSession } from '@/lib/client/session'

type Check = { invited: false } | { invited: true; signIn: 'google' | 'password'; status: 'pending' | 'active' | 'expired' }

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    if (error.message.includes('not configured')) return 'Sign-in is not configured for this environment yet.'
    if (error.message.startsWith("That Google account isn't")) return error.message
    if (/auth\/(wrong-password|invalid-credential)/.test(error.message)) return 'Wrong password. Check your password and try again.'
  }
  return 'We could not sign you in. Check your details and try again.'
}

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

  useEffect(() => {
    if (!check) emailControl.current?.focus()
    else if (!check.invited || check.status === 'expired') changeControl.current?.focus()
    else if (check.signIn === 'password') passwordControl.current?.focus()
    else googleControl.current?.focus()
  }, [check])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || !ready) return
    const password = new FormData(event.currentTarget).get('password')
    setPending(true)
    setError(null)
    try {
      if (!check) {
        const response = await fetch('/api/sign-in/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim() }),
          cache: 'no-store',
        })
        if (!response.ok) throw new Error('Email check failed')
        setEmail(email.trim())
        setCheck(await response.json())
      } else if (check.invited && check.status !== 'expired') {
        if (check.signIn === 'google') await signInWithGoogle(email)
        else await signInWithEmail(email, String(password ?? ''))
      }
    } catch (nextError) {
      setError(errorMessage(nextError))
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="sign-in-card" aria-labelledby="sign-in-title">
      <Brand />
      <h1 id="sign-in-title" className="dialog-title">Sign in</h1>
      <p>{check ? email : 'Enter your email to continue to Plate Curator.'}</p>
      <form className="flex flex-col gap-4" onSubmit={submit} aria-busy={pending}>
        {!check ? (
          <>
            <label className="flex flex-col gap-2 text-sm font-semibold text-foreground" htmlFor="email">
              Email
              <input key="email" ref={emailControl} id="email" name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={pending} />
            </label>
            <Button type="submit" disabled={!ready || pending}>{pending ? 'Checking' : 'Continue'}</Button>
          </>
        ) : !check.invited ? (
          <p role="status">Plate Curator is invite-only. Ask the Owner for an invite.</p>
        ) : check.status === 'expired' ? (
          <p role="status">Your invite has expired. Ask the Owner for a new one.</p>
        ) : check.signIn === 'google' ? (
          <Button ref={googleControl} type="submit" disabled={!ready || pending}>
            <IoLogoGoogle data-icon="inline-start" aria-hidden size={16} />
            {pending ? 'Connecting' : 'Continue with Google'}
          </Button>
        ) : (
          <>
            <label className="flex flex-col gap-2 text-sm font-semibold text-foreground" htmlFor="password">
              Password
              <input key="password" ref={passwordControl} id="password" name="password" type="password" autoComplete="current-password" required disabled={pending} />
            </label>
            <Button type="submit" disabled={!ready || pending}>{pending ? 'Signing in' : 'Sign in'}</Button>
          </>
        )}
        <div aria-live="polite">{error ? <p role="alert">{error}</p> : null}</div>
        {check ? <Button ref={changeControl} variant="ghost" type="button" disabled={pending} onClick={() => { setCheck(null); setError(null) }}>Change email</Button> : null}
      </form>
    </section>
  )
}
