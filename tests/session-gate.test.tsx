import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, test, vi } from 'vitest'
import { ApiError } from '../lib/client/api'

const session = { ready: false, user: null as null | { uid: string } }
const me = { data: undefined as undefined | { role: string }, error: undefined as undefined | ApiError }
vi.mock('../lib/client/session', () => ({ useSession: () => session }))
vi.mock('../lib/client/hooks', () => ({ useMe: () => me }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }))

const { SessionGate } = await import('../components/app/session-gate')

beforeEach(() => {
  session.ready = false
  session.user = null
  me.data = undefined
  me.error = undefined
})

test('renders the page before the session is known, so the server can render it', () => {
  expect(renderToStaticMarkup(<SessionGate><p>dashboard</p></SessionGate>)).toContain('dashboard')
})

test('hides the page once the session is known to be signed out', () => {
  session.ready = true
  const html = renderToStaticMarkup(<SessionGate><p>dashboard</p></SessionGate>)
  expect(html).not.toContain('dashboard')
  expect(html).toContain('Redirecting')
})

test('shows the page to a signed-in Member', () => {
  session.ready = true
  session.user = { uid: 'u1' }
  me.data = { role: 'editor' }
  expect(renderToStaticMarkup(<SessionGate><p>dashboard</p></SessionGate>)).toContain('dashboard')
})

test('hides the dashboard while membership is being checked', () => {
  session.ready = true
  session.user = { uid: 'u1' }
  const html = renderToStaticMarkup(<SessionGate><p>dashboard</p></SessionGate>)
  expect(html).not.toContain('dashboard')
  expect(html).toContain('Checking access')
})

test('shows No access with Sign out when the signed-in user is not a Member, even with stale actor data', () => {
  session.ready = true
  session.user = { uid: 'u1' }
  me.data = { role: 'editor' }
  me.error = new ApiError(403, 'not_member', {})
  const html = renderToStaticMarkup(<SessionGate><p>dashboard</p></SessionGate>)
  expect(html).not.toContain('dashboard')
  expect(html).toContain('No access')
  expect(html).toContain('Ask the Owner for an invite.')
  expect(html).toContain('Sign out</button>')
})

test('an access-check failure does not expose the dashboard', () => {
  session.ready = true
  session.user = { uid: 'u1' }
  me.error = new ApiError(503, 'unavailable', {})
  const html = renderToStaticMarkup(<SessionGate><p>dashboard</p></SessionGate>)
  expect(html).not.toContain('dashboard')
  expect(html).toContain('Could not check access')
})

test('the sign-in page variant hides itself from a signed-in user', () => {
  session.ready = true
  session.user = { uid: 'u1' }
  expect(renderToStaticMarkup(<SessionGate signedIn={false}><p>form</p></SessionGate>)).not.toContain('form')
})
