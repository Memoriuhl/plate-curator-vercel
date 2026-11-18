import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SessionGate } from '@/components/app/session-gate'
import { InvitePage } from '@/components/members/invite-page'

export const metadata: Metadata = {
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
}

/** Resolve the route token before rendering the invite acceptance screen. */
async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <InvitePage token={token} />
}

/** Render invitation acceptance with session handling and a loading boundary. */
export default function Page({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  return (
    <SessionGate signedIn={false}>
      <main className="sign-in-main">
        <Suspense fallback={<p role="status">Checking your invite…</p>}>
          <Invite params={params} />
        </Suspense>
      </main>
    </SessionGate>
  )
}
