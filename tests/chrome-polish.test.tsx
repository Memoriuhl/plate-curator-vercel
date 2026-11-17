import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { Button } from '../components/ui/button'
import { PublishButton } from '../components/dashboard/publish-button'
import { WorkspaceTabs } from '../components/app/workspace-tabs'

vi.mock('next/navigation', () => ({ usePathname: () => '/' }))
vi.mock('../lib/client/hooks', () => ({ useMe: () => ({ data: { role: 'owner' } }) }))

test('approved Owners can open Publish', () => {
  const html = renderToStaticMarkup(<PublishButton batchId="batch /B" owner approved />)
  expect(html).toContain('href="/publish?batch=batch%20%2FB"')
  expect(html).toContain('Publish to players')
  expect(html).not.toContain('aria-disabled=')
})

test.each([
  [true, false, 'Approve the batch first'],
  [false, true, 'Only Owners can publish'],
  [false, false, 'Only Owners can publish'],
])('Publish gating for owner=%s approved=%s', (owner, approved, reason) => {
  const html = renderToStaticMarkup(<PublishButton batchId="batch-b" owner={owner} approved={approved} />)
  expect(html).toContain('aria-disabled="true"')
  expect(html).toContain(reason)
  expect(html).not.toContain('href=')
})

test('workspace tabs omit Strip Art', () => {
  expect(renderToStaticMarkup(<WorkspaceTabs />)).not.toContain('Strip Art')
})

test('all button variants and sizes share flex alignment and fixed icon sizes', () => {
  for (const variant of ['primary', 'outline', 'ghost', 'publish', 'push'] as const) {
    for (const size of ['default', 'sm', 'icon'] as const) {
      const html = renderToStaticMarkup(<Button variant={variant} size={size}><svg aria-hidden="true" />{size !== 'icon' && 'Add fact'}</Button>)
      for (const token of ['items-center', 'justify-center', '[&amp;_svg]:size-4']) expect(html).toContain(token)
    }
  }
})
