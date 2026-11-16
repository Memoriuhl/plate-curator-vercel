import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MembersPage } from '../components/members/members-page'
import { HeaderActions } from '../components/app/header-actions'
import { TooltipProvider } from '../components/ui/tooltip'
import { ApiError } from '../lib/client/api'
import type { MemberSummary } from '../lib/members/summary'

const mocks = vi.hoisted(() => ({ me: { data: { uid: 'owner', role: 'owner' } }, list: vi.fn(), invite: vi.fn(), mutate: vi.fn(), clipboard: vi.fn() }))
vi.mock('../lib/client/hooks', () => ({ useMe: () => mocks.me, useMembers: mocks.list, useInviteMember: () => mocks.invite }))
vi.mock('../lib/client/session', () => ({ useSession: () => ({ ready: true, user: { uid: 'owner', email: 'owner@example.com' }, signOut: vi.fn() }) }))
const members: MemberSummary[] = ['active', 'pending', 'expired'].map(status => ({ email: `${status}@example.com`, role: 'editor', signIn: 'google', status: status as MemberSummary['status'], invitedBy: status === 'pending' ? 'owner' : null, createdAt: '2026-11-16' }))
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  mocks.me.data = { uid: 'owner', role: 'owner' }
  mocks.list.mockReturnValue({ data: members, mutate: mocks.mutate })
  mocks.invite.mockResolvedValue({ member: { ...members[1], email: 'new@example.com' }, inviteUrl: 'https://example.com/invite/new-token' })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.clipboard.mockResolvedValue(undefined) } })
})
afterEach(cleanup)

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
