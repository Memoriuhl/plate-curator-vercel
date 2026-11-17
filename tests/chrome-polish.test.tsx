import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { Toggle } from '../components/ui/toggle'
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
      for (const token of ['items-center', 'justify-center', 'font-sans', '[&amp;_svg]:size-4']) expect(html).toContain(token)
      for (const token of ['pt-[0.2em]', '[&amp;_svg]:-mt-[0.2em]']) {
        if (size === 'icon') expect(html).not.toContain(token)
        else expect(html).toContain(token)
      }
    }
  }
})

test('toggle sizes use the measured text offset and preserve icon position', () => {
  for (const size of ['default', 'sm', 'lg'] as const) {
    const html = renderToStaticMarkup(<Toggle size={size}><svg />Set by hand</Toggle>)
    for (const token of ['font-sans', 'pt-[0.2em]', '[&amp;_svg]:-mt-[0.2em]']) expect(html).toContain(token)
  }
})
