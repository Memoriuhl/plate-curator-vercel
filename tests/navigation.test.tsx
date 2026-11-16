import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, test, vi } from 'vitest'
import type { JurisdictionSummary } from '@/lib/catalog/dashboard-types'

const route = vi.hoisted(() => ({ code: 'AK', pending: false }))
vi.mock('next/navigation', () => ({ useParams: () => ({ code: route.code }) }))
vi.mock('next/link', () => ({
  default: ({ children, prefetch, onMouseEnter, onFocus, scroll, ...props }: Record<string, unknown>) => {
    void prefetch
    void onMouseEnter
    void onFocus
    void scroll
    return <a {...props}>{children as React.ReactNode}</a>
  },
  useLinkStatus: () => ({ pending: route.pending }),
}))

const { JurisdictionCard } = await import('@/components/dashboard/jurisdiction-card')
const jurisdiction = { code: 'AL', name: 'Alabama', plateCount: 10, completeCount: 4 } as JurisdictionSummary

beforeEach(() => {
  route.code = 'AK'
  route.pending = false
})

test('selected jurisdiction follows the route params', () => {
  expect(renderToStaticMarkup(<JurisdictionCard jurisdiction={jurisdiction} />)).not.toContain('aria-current')
  route.code = 'AL'
  expect(renderToStaticMarkup(<JurisdictionCard jurisdiction={jurisdiction} />)).toContain('aria-current="page"')
})

test('the pending link exposes its loading indicator', () => {
  const idle = renderToStaticMarkup(<JurisdictionCard jurisdiction={jurisdiction} />)
  expect(idle).not.toContain('data-navigation-pending')
  expect(idle).not.toContain('animate-spin')
  expect(idle).not.toContain('role="status"')
  route.pending = true
  const html = renderToStaticMarkup(<JurisdictionCard jurisdiction={jurisdiction} />)
  expect(html).toContain('data-navigation-pending')
  expect(html).toContain('role="status"')
  expect(html).toContain('Loading')
  expect(html).toContain('animate-spin')
})
