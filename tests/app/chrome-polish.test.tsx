import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { Toggle } from '../../components/ui/toggle'
import { Button } from '../../components/ui/button'
import { PublishButton } from '../../components/dashboard/publish-button'
import { WorkspaceTabs } from '../../components/app/workspace-tabs'

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams('batch=batch%20%2FB'),
}))
vi.mock('../../lib/client/hooks', () => ({
  useMe: () => ({ data: { role: 'owner' } }),
  useBatches: () => ({}),
}))

test('Owners can open Publish for the exact Batch', () => {
  const html = renderToStaticMarkup(<PublishButton batchId="batch /B" owner />)
  expect(html).toContain('href="/publish?batch=batch%20%2FB"')
  expect(html).toContain('Publish')
  expect(html).not.toContain('aria-disabled=')
})

test('only an Owner with a selected Batch sees the contextual Publish action', () => {
  expect(
    renderToStaticMarkup(<PublishButton batchId="batch-b" owner={false} />)
  ).toBe('')
  expect(renderToStaticMarkup(<PublishButton owner />)).toBe('')
})

test('Review opens all changes, Publish carries the selected Batch and the Dashboard only the shared draft', () => {
  const html = renderToStaticMarkup(<WorkspaceTabs />)
  expect(html).not.toContain('Strip Art')
  expect(html).toContain('href="/review"')
  expect(html).toContain('href="/publish?batch=batch%20%2FB"')
  // An old Batch is history, which the Dashboard no longer shows.
  expect(html).toContain('href="/"')
  expect(html).not.toContain('href="/?batch=')
})

test('all button variants and sizes share flex alignment and fixed icon sizes', () => {
  for (const variant of [
    'primary',
    'outline',
    'ghost',
    'publish',
    'push',
  ] as const) {
    for (const size of ['default', 'sm', 'icon'] as const) {
      const html = renderToStaticMarkup(
        <Button variant={variant} size={size}>
          <svg aria-hidden="true" />
          {size !== 'icon' && 'Add fact'}
        </Button>
      )
      for (const token of [
        'items-center',
        'justify-center',
        'font-sans',
        '[&amp;_svg]:size-4',
      ])
        expect(html).toContain(token)
      for (const token of ['pt-[0.2em]', '[&amp;_svg]:-mt-[0.2em]']) {
        if (size === 'icon') expect(html).not.toContain(token)
        else expect(html).toContain(token)
      }
    }
  }
})

test('toggle sizes use the measured text offset and preserve icon position', () => {
  for (const size of ['default', 'sm', 'lg'] as const) {
    const html = renderToStaticMarkup(
      <Toggle size={size}>
        <svg />
        Set by hand
      </Toggle>
    )
    for (const token of ['font-sans', 'pt-[0.2em]', '[&amp;_svg]:-mt-[0.2em]'])
      expect(html).toContain(token)
  }
})
