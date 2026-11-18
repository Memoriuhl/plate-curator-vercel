'use client'

import { useState, type FormEvent } from 'react'
import { IoPeopleOutline, IoPersonAddOutline } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useInviteMember, useMe, useMembers } from '@/lib/client/hooks'
import { ApiError } from '@/lib/client/api'
import { InviteResult } from './invite-result'
import { ReissueInvite } from './reissue-invite'
import type { MemberInvite, MemberSummary } from '@/lib/members/summary'
import { MemberRoleActions } from './member-role-actions'

/** Map the stored membership role to the text shown in the management UI. */
const roleName = (role: MemberSummary['role']) => role === 'owner' ? 'Owner' : 'Editor'
const statusName = { active: 'Active', pending: 'Pending', expired: 'Expired' }
const statusTint = { active: 'bg-[var(--success-tint)]', pending: 'bg-[var(--fill)]', expired: 'bg-[var(--warning-tint)]' }

/** Collect a new member's email and role and display the resulting invitation link. */
function InviteForm() {
  const invite = useInviteMember()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<MemberSummary['role']>('editor')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<MemberInvite | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * Submit the invitation once, reset successful inputs and surface errors on the form.
   */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      setResult(await invite(email.trim(), role))
      setEmail('')
      setRole('editor')
    } catch (nextError) {
      setError(nextError instanceof ApiError && nextError.code === 'member_exists' ? 'That email is already a Member.' : 'Could not create the invite. Please try again.')
    } finally { setPending(false) }
  }
  return (
    <section className="rounded-[var(--radius-lg)] bg-card p-6" aria-labelledby="invite-title">
      <IoPersonAddOutline className="mb-3 size-6" aria-hidden="true" />
      <h2 id="invite-title" className="text-xl font-extrabold">Invite a Member</h2>
      <p className="mb-6 mt-2 text-sm text-muted-foreground">Give someone access with their Google account. You send the invite personally.</p>
      <form className="flex flex-col gap-4" onSubmit={submit} aria-busy={pending}>
        <label className="flex flex-col gap-2 text-sm font-bold" htmlFor="member-email">Email
          <input id="member-email" name="email" type="email" required autoComplete="off" maxLength={254} placeholder="person@example.com" value={email} onChange={event => setEmail(event.target.value)} disabled={pending} className="min-w-0 rounded-full bg-muted px-4 py-3 font-semibold" />
        </label>
        <div className="flex flex-col gap-2 text-sm font-bold">
          <label htmlFor="member-role">Role</label>
          <Select value={role} onValueChange={value => setRole(value as MemberSummary['role'])} disabled={pending}>
            <SelectTrigger id="member-role" className="h-11 w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="editor">Editor</SelectItem><SelectItem value="owner">Owner</SelectItem></SelectContent>
          </Select>
          <p className="text-xs font-semibold text-muted-foreground">{role === 'owner' ? 'Owners can manage Members and publish the catalog.' : 'Editors can edit Plates and submit Batches for review.'}</p>
        </div>
        <Button type="submit" disabled={pending}><IoPersonAddOutline aria-hidden="true" />{pending ? 'Inviting…' : 'Invite'}</Button>
      </form>
      {result ? <InviteResult key={result.inviteUrl} result={result} onDismiss={() => setResult(null)} /> : null}
      <div aria-live="polite">{error ? <p role="alert" className="mt-4 text-sm">{error}</p> : null}</div>
    </section>
  )
}

/** Render the owner-only membership list and invitation workflow. */
export function MembersPage() {
  const me = useMe()
  const members = useMembers()
  if (!me.data) return <main className="app-main"><p role="status">Checking access…</p></main>
  if (me.data.role !== 'owner') return <main className="app-main"><h1 className="page-title">Members</h1><p className="mt-4">Only Owners can manage Members.</p></main>
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 md:px-6">
      <header className="mb-8 flex items-start gap-4">
        <span className="rounded-2xl bg-card p-3"><IoPeopleOutline className="size-7" aria-hidden="true" /></span>
        <div><h1 className="page-title">Members</h1><p className="mt-2 text-sm text-muted-foreground">Control who has access to Plate Curator.</p></div>
      </header>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0 rounded-[var(--radius-lg)] bg-card" aria-labelledby="members-list-title">
          <header className="flex flex-wrap items-center justify-between gap-2 p-6"><h2 id="members-list-title" className="text-xl font-extrabold">People with access</h2><span className="font-mono text-sm text-muted-foreground">{members.data ? `${members.data.length} Members` : '…'}</span></header>
          {members.error ? <p role="alert" className="px-6 pb-6">Could not load Members. <Button variant="ghost" size="sm" onClick={() => void members.mutate()}>Try again</Button></p> : !members.data ? <p role="status" className="px-6 pb-6">Loading Members…</p> : members.data.length === 0 ? <p className="px-6 pb-6 text-muted-foreground">No Members yet. Invite someone to get started.</p> : (
            <ul className="m-0 list-none divide-y divide-[var(--hairline)] p-0">
              {members.data.map(member => (
                <li key={member.email} className="flex gap-3 px-6 py-5">
                  <Avatar className="mt-1 size-9 shrink-0"><AvatarFallback>{member.email[0].toUpperCase()}</AvatarFallback></Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="break-all font-bold">{member.email}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span className="font-bold">{roleName(member.role)}</span><span className={`rounded-full px-2.5 py-1 font-bold ${statusTint[member.status]}`}>{statusName[member.status]}</span><span className="text-muted-foreground">{member.signIn === 'google' ? 'Google' : 'Password'}</span></div>
                    <MemberRoleActions member={member} />
                    <p className="mt-2 break-all text-xs text-muted-foreground">{member.invitedBy ? `Invited by ${member.invitedBy === me.data?.uid ? 'you' : member.invitedBy}` : 'Starting Member'}</p>
                    <ReissueInvite member={member} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="px-6 py-4 text-xs text-muted-foreground">Only Members can enter. Invite links work once and expire in 7 days.</p>
        </section>
        <InviteForm />
      </div>
    </main>
  )
}
