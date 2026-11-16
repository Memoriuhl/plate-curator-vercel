'use client'

import { useEffect, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from '../../lib/client/session'

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
  if (!ready && !signedIn) return children
  if (!ready || !allowed)
    return (
      <main className="session-loading" role="status">
        {ready ? 'Redirecting...' : 'Loading Plate Curator...'}
      </main>
    )
  return children
}
