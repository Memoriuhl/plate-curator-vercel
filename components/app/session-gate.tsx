'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from '../../lib/client/session'
import { useMe } from '../../lib/client/hooks'
import { ApiError } from '../../lib/client/api'
import { Button } from '../ui/button'

/** Wait for a signed-in user's membership before allowing access to curator content. */
function MembershipGate({ children }: { children: ReactNode }) {
  const { signOut } = useSession()
  const me = useMe()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  /**
   * Let the blocked user leave the current session and surface retryable sign-out
   * failures.
   */
  async function handleSignOut() {
    setPending(true)
    setError(false)
    try { await signOut() } catch { setError(true) } finally { setPending(false) }
  }
  if (me.error instanceof ApiError && me.error.code === 'not_member') return (
    <main className="sign-in-main">
      <section className="sign-in-card" aria-labelledby="no-access-title">
        <h1 id="no-access-title">No access</h1>
        <p>Your account doesn&apos;t have access to Plate Curator. Ask the Owner for an invite.</p>
        <Button onClick={() => void handleSignOut()} disabled={pending}>Sign out</Button>
        {error ? <p role="alert">Could not sign out. Try again.</p> : null}
      </section>
    </main>
  )
  if (!me.data) return <main className="session-loading" role="status">{me.error ? 'Could not check access. Please try again.' : 'Checking access...'}</main>
  return children
}

/** Route users to the appropriate screen as authentication initializes or changes. */
export function SessionGate({
  children,
  signedIn = true,
}: {
  children: ReactNode
  signedIn?: boolean
}) {
  const { ready, user } = useSession()
  const router = useRouter()
  const allowed = signedIn ? !!user : !user
  useEffect(() => {
    if (ready && !allowed) router.replace(signedIn ? '/sign-in' : '/')
  }, [ready, allowed, router, signedIn])
  if (ready && !allowed)
    return (
      <main className="session-loading" role="status">
        Redirecting...
      </main>
    )
  return signedIn && ready && user ? <MembershipGate>{children}</MembershipGate> : children
}
