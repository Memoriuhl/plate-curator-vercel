import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import { HeaderActions } from '../../components/app/header-actions'

vi.mock('../../lib/client/session', () => ({
  useSession: () => ({
    ready: true,
    user: { displayName: 'Owner', email: 'owner@example.com', photoURL: null },
    signOut: async () => {},
  }),
}))
vi.mock('../../lib/client/hooks', () => ({
  useMe: () => ({ data: { role: 'owner' } }),
}))

test('the profile trigger drops the text offset so the avatar and chevron stay centered', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <HeaderActions />
    </TooltipProvider>
  )
  const trigger = html.match(
    /<button [^>]*aria-label="Open profile menu"[^>]*>/
  )?.[0]
  expect(trigger).toBeDefined()
  expect(trigger).toContain('pt-0')
  expect(trigger).toContain('[&amp;_svg]:mt-0')
  expect(trigger).not.toContain('pt-[0.2em]')
  expect(trigger).not.toContain('[&amp;_svg]:-mt-[0.2em]')
})
