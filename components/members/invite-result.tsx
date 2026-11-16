'use client'

import { useId, useState } from 'react'
import { IoCheckmarkOutline, IoCopyOutline } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import type { MemberInvite } from '@/lib/members/summary'

export function InviteResult({ result, onDismiss }: { result: MemberInvite; onDismiss: () => void }) {
  const inputId = useId()
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  async function copy() {
    setError(false)
    setCopied(false)
    try {
      await navigator.clipboard.writeText(`You've been invited to Plate Curator as ${result.member.role === 'owner' ? 'Owner' : 'Editor'}. Open ${result.inviteUrl} and sign in with Google as ${result.member.email}. The link works once and expires in 7 days.`)
      setCopied(true)
    } catch { setError(true) }
  }
  return (
    <div className="mt-6 flex min-w-0 flex-col gap-3 rounded-2xl bg-muted p-4" role="region" aria-label="New invite">
      <p role="status" className="font-extrabold">Invite ready</p>
      <p className="break-all text-sm">{result.member.email} · {result.member.role === 'owner' ? 'Owner' : 'Editor'}</p>
      <label className="flex flex-col gap-2 text-sm font-bold" htmlFor={inputId}>Invite link
        <input id={inputId} readOnly value={result.inviteUrl} className="w-full min-w-0 rounded-xl bg-card p-3 font-mono text-xs" onFocus={event => event.target.select()} />
      </label>
      <Button type="button" variant="outline" onClick={() => void copy()}>{copied ? <IoCheckmarkOutline aria-hidden="true" /> : <IoCopyOutline aria-hidden="true" />}{copied ? 'Copied' : 'Copy invite'}</Button>
      <p className="text-xs text-muted-foreground">Copy it before leaving. This link won&apos;t be shown again. Re-issue makes a new one.</p>
      <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>Dismiss link</Button>
      <div aria-live="polite">{error ? <p role="alert" className="text-sm">Could not copy the invite. Select and copy the link below.</p> : null}{copied ? <span className="sr-only">Invite copied</span> : null}</div>
    </div>
  )
}
