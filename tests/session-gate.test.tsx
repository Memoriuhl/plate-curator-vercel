import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, test, vi } from 'vitest'

const session = { ready: false, user: null as null | { uid: string } }
vi.mock('../lib/client/session', () => ({ useSession: () => session }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }))

const { SessionGate } = await import('../components/app/session-gate')

beforeEach(() => {
  session.ready = false
  session.user = null
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

test('shows the page to a signed-in user', () => {
  session.ready = true
  session.user = { uid: 'u1' }
  expect(renderToStaticMarkup(<SessionGate><p>dashboard</p></SessionGate>)).toContain('dashboard')
})

test('the sign-in page variant hides itself from a signed-in user', () => {
  session.ready = true
  session.user = { uid: 'u1' }
  expect(renderToStaticMarkup(<SessionGate signedIn={false}><p>form</p></SessionGate>)).not.toContain('form')
})
