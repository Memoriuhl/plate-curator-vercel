import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { InvitePage } from '../components/members/invite-page'
import { SessionGate } from '../components/app/session-gate'
import type { InviteLookup } from '../lib/client/invites'

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), google: vi.fn(), replace: vi.fn(), user: null as null | { uid: string } }))
vi.mock('../lib/client/invites', () => ({ useInvite: mocks.lookup }))
vi.mock('../lib/client/session', () => ({ /** Supply the fixture session and API client to the component under test. */ useSession: () => ({ ready: true, user: mocks.user, signInWithGoogle: mocks.google }) }))
vi.mock('../lib/client/hooks', () => ({ /** Supply the current fixture actor for role and account-dependent behavior. */ useMe: () => ({}) }))
vi.mock('next/navigation', () => ({ /** Capture or stub navigation so the test can drive routing without Next.js. */ useRouter: () => ({ replace: mocks.replace }) }))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.user = null
  mocks.google.mockResolvedValue(undefined)
  mocks.lookup.mockReturnValue({ data: { status: 'valid', email: 'member@example.com' } satisfies InviteLookup })
})
afterEach(cleanup)

test('valid invite shows only the invited email and sends it as the Google login hint', async () => {
  render(<InvitePage token="test-token" />)
  expect(screen.getByRole('heading', { name: "You've been invited to Plate Curator" })).toBeDefined()
  expect(screen.getByText('member@example.com')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
  await waitFor(() => expect(mocks.google).toHaveBeenCalledWith('member@example.com'))
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/'))
})

test.each(['expired', 'invalid'])('%s invite shows the shared unavailable message and sign-in link', status => {
  mocks.lookup.mockReturnValue({ data: { status, email: status === 'expired' ? 'member@example.com' : undefined } })
  render(<InvitePage token="test-token" />)
  expect(screen.getByRole('status').textContent).toBe('This invite was already used or has expired. Ask the Owner for a new one.')
  expect(screen.getByRole('link', { name: 'Go to sign in' }).getAttribute('href')).toBe('/sign-in')
  expect(screen.queryByText('member@example.com')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
})

test('a different Google account shows the session email-match refusal', async () => {
  const message = "That Google account isn't the invited one. Choose member@example.com in Google's account picker."
  mocks.google.mockRejectedValueOnce(new Error(message))
  render(<InvitePage token="test-token" />)
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message))
  expect(mocks.replace).not.toHaveBeenCalled()
})

test('already signed-in sessions redirect home without showing the Invite page', async () => {
  mocks.user = { uid: 'member' }
  render(<SessionGate signedIn={false}><InvitePage token="test-token" /></SessionGate>)
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/'))
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
})

test('lookup failures can be retried without showing a Google button', () => {
  const mutate = vi.fn()
  mocks.lookup.mockReturnValue({ error: new Error('Unavailable'), mutate })
  render(<InvitePage token="test-token" />)
  expect(screen.getByRole('alert').textContent).toContain('Could not check this invite')
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(mutate).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
})
