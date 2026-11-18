'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { IoLogoGoogle, IoMailOpenOutline } from 'react-icons/io5'
import { Brand } from '@/components/app/brand'
import { Button } from '@/components/ui/button'
import { useInvite } from '@/lib/client/invites'
import { useSession } from '@/lib/client/session'

/** Show invitation validity and guide the recipient through accepting with Google. */
export function InvitePage({ token }: { token: string }) {
  const invite = useInvite(token)
  const { ready, signInWithGoogle } = useSession()
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * Activate a valid invitation through sign-in and navigate to the workspace when it
   * succeeds.
   */
  async function accept() {
    if (invite.data?.status !== 'valid' || pending || !ready) return
    setPending(true)
    setError(null)
    try {
      await signInWithGoogle(invite.data.email)
      router.replace('/')
    } catch (nextError) {
      setError(nextError instanceof Error && nextError.message.startsWith("That Google account isn't") ? nextError.message : 'Could not sign in with Google. Please try again.')
    } finally { setPending(false) }
  }
  return (
    <section className="sign-in-card" aria-labelledby="invite-title">
      <Brand />
      {!invite.data ? (
        <><h1 id="invite-title" className="dialog-title">Your Invite link</h1>{invite.error ? <><p role="alert">Could not check this invite. Please try again.</p><Button variant="outline" onClick={() => void invite.mutate()}>Try again</Button></> : <p role="status">Checking your invite…</p>}</>
      ) : invite.data.status !== 'valid' ? (
        <><h1 id="invite-title" className="dialog-title">Invite unavailable</h1><p role="status">This invite was already used or has expired. Ask the Owner for a new one.</p><Button asChild variant="outline"><Link href="/sign-in">Go to sign in</Link></Button></>
      ) : (
        <div className="flex flex-col gap-4">
          <IoMailOpenOutline className="size-7" aria-hidden="true" />
          <h1 id="invite-title" className="dialog-title">You&apos;ve been invited to Plate Curator</h1>
          <p>Sign in with your invited Google account to get started.</p>
          <p className="break-all rounded-2xl bg-muted px-4 py-3 font-bold">{invite.data.email}</p>
          <Button onClick={() => void accept()} disabled={pending || !ready}><IoLogoGoogle aria-hidden="true" />{pending ? 'Connecting…' : 'Continue with Google'}</Button>
          <p className="text-xs text-muted-foreground">This link works once and expires in 7 days.</p>
        </div>
      )}
      <div aria-live="polite">{error ? <p role="alert" className="mt-4 text-sm">{error}</p> : null}</div>
    </section>
  )
}
