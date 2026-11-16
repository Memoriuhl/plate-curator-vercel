'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useReissueInvite } from '@/lib/client/invites'
import type { MemberSummary } from '@/lib/members/summary'
import { InviteResult } from './invite-result'

export function ReissueInvite({ member }: { member: MemberSummary }) {
  const reissue = useReissueInvite()
  const [link, setLink] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  if (member.status === 'active') return null
  async function submit() {
    if (pending) return
    setPending(true)
    setError(false)
    try { setLink((await reissue(member.email)).inviteUrl) } catch { setError(true) } finally { setPending(false) }
  }
  return (
    <div className="mt-3">
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void submit()}>{pending ? 'Re-issuing…' : 'Re-issue invite'}</Button>
      {error ? <p role="alert" className="mt-2 text-sm">Could not re-issue the invite. Refresh Members and try again.</p> : null}
      {link ? <InviteResult key={link} result={{ member, inviteUrl: link }} onDismiss={() => setLink(null)} /> : null}
    </div>
  )
}
