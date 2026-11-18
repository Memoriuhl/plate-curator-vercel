import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MembersPage } from '../components/members/members-page'
import { HeaderActions } from '../components/app/header-actions'
import { TooltipProvider } from '../components/ui/tooltip'
import { ApiError } from '../lib/client/api'
import type { MemberSummary } from '../lib/members/summary'

const mocks = vi.hoisted(() => ({ me: { data: { uid: 'owner', role: 'owner' } }, list: vi.fn(), invite: vi.fn(), mutate: vi.fn(), clipboard: vi.fn(), send: vi.fn() }))
vi.mock('swr', async importOriginal => ({ ...await importOriginal<typeof import('swr')>(), /** Provide the mock cache actions used to observe refreshes after writes. */ useSWRConfig: () => ({ mutate: mocks.mutate }) }))
const reissue = vi.hoisted(() => vi.fn())
vi.mock('../lib/client/invites', () => ({ /** Return the fixture action that tracks reissued member invitations. */ useReissueInvite: () => reissue }))
vi.mock('../lib/client/hooks', () => ({ /** Supply the current fixture actor for role and account-dependent behavior. */ useMe: () => mocks.me, useMembers: mocks.list, /** Return the mocked invitation creator so the test can inspect the submitted member. */ useInviteMember: () => mocks.invite }))
vi.mock('../lib/client/session', () => ({ /** Supply the fixture session and API client to the component under test. */ useSession: () => ({ ready: true, user: { uid: 'owner', email: 'owner@example.com' }, signOut: vi.fn(), api: { send: mocks.send } }) }))
const members: MemberSummary[] = ['active', 'pending', 'expired'].map(status => ({ email: `${status}@example.com`, role: 'editor', signIn: 'google', status: status as MemberSummary['status'], invitedBy: status === 'pending' ? 'owner' : null, createdAt: '2026-11-16' }))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.mutate.mockResolvedValue(undefined)
  mocks.send.mockResolvedValue({ ok: true })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  mocks.me.data = { uid: 'owner', role: 'owner' }
  mocks.list.mockReturnValue({ data: members, mutate: mocks.mutate })
  mocks.invite.mockResolvedValue({ member: { ...members[1], email: 'new@example.com' }, inviteUrl: 'https://example.com/invite/new-token' })
  reissue.mockResolvedValue({ inviteUrl: 'https://example.com/invite/reissued-token' })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.clipboard.mockResolvedValue(undefined) } })
})
afterEach(cleanup)

test('each role control sends the selected role and refreshes Members', async () => {
  render(<MembersPage />)
  fireEvent.change(screen.getByRole('combobox', { name: 'Role for active@example.com' }), { target: { value: 'owner' } })
  await waitFor(() => expect(mocks.send).toHaveBeenCalledWith('PATCH', '/api/members/active%40example.com', { role: 'owner' }))
  expect(mocks.mutate).toHaveBeenCalledWith('/api/members')
})

test('removal names the email, cancels safely, and restores focus to the row', async () => {
  render(<MembersPage />)
  const trigger = screen.getByRole('button', { name: 'Remove active@example.com' })
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog.textContent).toContain('Remove active@example.com?')
  expect(mocks.send).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(document.activeElement).toBe(trigger)
})

test('confirmed removal sends DELETE and refreshes the list', async () => {
  render(<MembersPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Remove active@example.com' }))
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove Member' }))
  await waitFor(() => expect(mocks.send).toHaveBeenCalledWith('DELETE', '/api/members/active%40example.com', undefined))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
})

test('removing a row returns focus to an adjacent row', async () => {
  const view = render(<MembersPage />)
  mocks.mutate.mockImplementationOnce(async () => {
    mocks.list.mockReturnValue({ data: members.slice(1), mutate: mocks.mutate })
    view.rerender(<MembersPage />)
  })
  fireEvent.click(screen.getByRole('button', { name: 'Remove active@example.com' }))
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove Member' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove active@example.com' })).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Role for pending@example.com' })))
})

test.each(['role', 'remove'])('last-Owner refusal for %s is readable and returns focus', async action => {
  mocks.send.mockRejectedValueOnce(new ApiError(409, 'last_owner', {}))
  render(<MembersPage />)
  if (action === 'role') fireEvent.change(screen.getByRole('combobox', { name: 'Role for active@example.com' }), { target: { value: 'owner' } })
  else {
    fireEvent.click(screen.getByRole('button', { name: 'Remove active@example.com' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove Member' }))
  }
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('at least one Owner Member'))
  expect(mocks.mutate).not.toHaveBeenCalled()
  if (action === 'remove') expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove active@example.com' }))
})

test('self-removal explains that another Owner must remain and refreshes access', async () => {
  mocks.list.mockReturnValue({ data: [{ ...members[0], email: 'owner@example.com', role: 'owner' }], mutate: mocks.mutate })
  render(<MembersPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Remove owner@example.com' }))
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog.textContent).toContain('You are removing yourself. Another Owner Member must remain')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Member' }))
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('/api/me'))
})

test('lists Members with statuses and an Editor-default role choice', () => {
  render(<MembersPage />)
  for (const status of ['Active', 'Pending', 'Expired']) expect(screen.getByText(status)).toBeDefined()
  expect(screen.getByText('Invited by you')).toBeDefined()
  expect(screen.getByLabelText('Email')).toBeDefined()
  expect(screen.getByRole('combobox', { name: 'Role' }).textContent).toContain('Editor')
  expect(screen.queryByRole('button', { name: 'Copy invite' })).toBeNull()
})

test('creates an invite, copies the full message, and never restores its link from list data', async () => {
  const view = render(<MembersPage />)
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
  await waitFor(() => expect(screen.getByLabelText('Invite link')).toBeDefined())
  expect(mocks.invite).toHaveBeenCalledWith('new@example.com', 'editor')
  expect((screen.getByLabelText('Invite link') as HTMLInputElement).value).toBe('https://example.com/invite/new-token')
  fireEvent.click(screen.getByRole('button', { name: 'Copy invite' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeDefined())
  expect(mocks.clipboard).toHaveBeenCalledWith("You've been invited to Plate Curator as Editor. Open https://example.com/invite/new-token and sign in with Google as new@example.com. The link works once and expires in 7 days.")
  expect(screen.getByText(/This link won't be shown again/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss link' }))
  expect(screen.queryByLabelText('Invite link')).toBeNull()
  view.unmount()
  render(<MembersPage />)
  expect(screen.queryByLabelText('Invite link')).toBeNull()
})

test('the role choice offers Owner and submits the chosen role', async () => {
  render(<MembersPage />)
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Role' }), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('option', { name: 'Owner' }))
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
  await waitFor(() => expect(mocks.invite).toHaveBeenCalledWith('new@example.com', 'owner'))
})

test('reports duplicate Members and leaves the form available', async () => {
  mocks.invite.mockRejectedValueOnce(new ApiError(409, 'member_exists', {}))
  render(<MembersPage />)
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'pending@example.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That email is already a Member.'))
  expect(screen.queryByLabelText('Invite link')).toBeNull()
})

test('clipboard failure retains the selectable link', async () => {
  mocks.clipboard.mockRejectedValueOnce(new Error('Clipboard unavailable'))
  render(<MembersPage />)
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Copy invite' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Select and copy the link below'))
  expect(screen.getByLabelText('Invite link')).toBeDefined()
})

test('Editors see the access message instead of the list and invite form', () => {
  mocks.me.data.role = 'editor'
  render(<MembersPage />)
  expect(screen.getByText('Only Owners can manage Members.')).toBeDefined()
  expect(screen.queryByLabelText('Email')).toBeNull()
  expect(screen.queryByText('active@example.com')).toBeNull()
})

test.each(['editor', 'owner'])('profile menu shows Members only to Owners: %s', async role => {
  mocks.me.data.role = role
  render(<TooltipProvider><HeaderActions /></TooltipProvider>)
  fireEvent.keyDown(screen.getByRole('button', { name: 'Open profile menu' }), { key: 'Enter' })
  await screen.findByRole('menuitem', { name: 'Sign out' })
  expect(!!screen.queryByRole('menuitem', { name: 'Members' })).toBe(role === 'owner')
})

test('pending and expired Members offer Re-issue and show the new link once', async () => {
  const view = render(<MembersPage />)
  const buttons = screen.getAllByRole('button', { name: 'Re-issue invite' })
  expect(buttons).toHaveLength(2)
  fireEvent.click(buttons[0])
  await screen.findByLabelText('Invite link')
  expect(reissue).toHaveBeenCalledWith('pending@example.com')
  expect((screen.getByLabelText('Invite link') as HTMLInputElement).value).toBe('https://example.com/invite/reissued-token')
  fireEvent.click(screen.getByRole('button', { name: 'Copy invite' }))
  await waitFor(() => expect(mocks.clipboard).toHaveBeenCalledWith("You've been invited to Plate Curator as Editor. Open https://example.com/invite/reissued-token and sign in with Google as pending@example.com. The link works once and expires in 7 days."))
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss link' }))
  expect(screen.queryByLabelText('Invite link')).toBeNull()
  view.unmount()
  render(<MembersPage />)
  expect(screen.queryByLabelText('Invite link')).toBeNull()
})
