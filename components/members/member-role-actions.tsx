'use client'

import { useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { useSession } from '@/lib/client/session'
import { ApiError } from '@/lib/client/api'
import { normalizeEmail } from '@/lib/members/member'
import type { MemberSummary } from '@/lib/members/summary'

export function MemberRoleActions({ member }: { member: MemberSummary }) {
  const { api, user } = useSession()
  const { mutate } = useSWRConfig()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const removeControl = useRef<HTMLButtonElement>(null)
  const self = normalizeEmail(user?.email ?? '') === member.email

  async function change(role?: MemberSummary['role']) {
    if (pending) return
    setPending(true)
    setError(null)
    const row = removeControl.current?.closest('li')
    const fallback = row?.nextElementSibling?.querySelector<HTMLElement>('select, button')
      ?? row?.previousElementSibling?.querySelector<HTMLElement>('select, button')
      ?? document.getElementById('member-email')
    try {
      await api.send(role ? 'PATCH' : 'DELETE', `/api/members/${encodeURIComponent(member.email)}`, role ? { role } : undefined)
      await mutate('/api/members').catch(() => undefined)
      if (self) await mutate('/api/me').catch(() => undefined)
      setOpen(false)
      if (!role) fallback?.focus()
    } catch (nextError) {
      setError(nextError instanceof ApiError && nextError.code === 'last_owner'
        ? 'Plate Curator needs at least one Owner Member. Make another Member an Owner before changing or removing this Owner.'
        : 'Could not update this Member. Please try again.')
      setOpen(false)
    } finally { setPending(false) }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`role-${member.email}`}>Role for {member.email}</label>
      <select id={`role-${member.email}`} value={member.role} disabled={pending} onChange={event => void change(event.target.value as MemberSummary['role'])} className="rounded-full bg-muted px-3 py-2 text-sm font-bold">
        <option value="editor">Editor</option><option value="owner">Owner</option>
      </select>
      <AlertDialog open={open} onOpenChange={value => { if (!pending) setOpen(value) }}>
        <AlertDialogTrigger asChild><Button ref={removeControl} variant="ghost" size="sm" disabled={pending} aria-label={`Remove ${member.email}`}>Remove</Button></AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Member?</AlertDialogTitle>
            <AlertDialogDescription className="break-all">Remove {member.email}? Their access ends on their next request.{self ? ' You are removing yourself. Another Owner Member must remain, and you will lose access.' : ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button disabled={pending} onClick={() => void change()}>{pending ? 'Removing…' : 'Remove Member'}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="w-full text-sm" aria-live="polite">{error ? <p role="alert">{error}</p> : null}</div>
    </div>
  )
}
