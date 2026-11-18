import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, test, vi } from 'vitest'
import type { JurisdictionSummary } from '@/lib/catalog/dashboard-types'

const route = vi.hoisted(() => ({ code: 'AK', query: '', pending: false }))
vi.mock('next/navigation', () => ({
  /** Supply the query parameters that define the fixture workspace state. */ useSearchParams:
    () => new URLSearchParams(route.query),
  /** Provide the route parameters for the selected fixture page. */ useParams:
    () => ({ code: route.code }),
}))
vi.mock('next/link', () => ({
  /** Render link children and href directly so tests can inspect workspace navigation. */
  default: ({
    children,
    prefetch,
    onMouseEnter,
    onFocus,
    scroll,
    ...props
  }: Record<string, unknown>) => {
    void prefetch
    void onMouseEnter
    void onFocus
    void scroll
    return <a {...props}>{children as React.ReactNode}</a>
  },
  /** Set the fixture navigation pending state without starting a real transition. */
  useLinkStatus: () => ({ pending: route.pending }),
}))

const { JurisdictionCard } =
  await import('@/components/dashboard/jurisdiction-card')
const jurisdiction = {
  code: 'AL',
  name: 'Alabama',
  plateCount: 10,
  completeCount: 4,
} as JurisdictionSummary

beforeEach(() => {
  route.query = ''
  route.code = 'AK'
  route.pending = false
})

test('selected jurisdiction follows the route params', () => {
  expect(
    renderToStaticMarkup(<JurisdictionCard jurisdiction={jurisdiction} />)
  ).not.toContain('aria-current')
  route.code = 'AL'
  expect(
    renderToStaticMarkup(<JurisdictionCard jurisdiction={jurisdiction} />)
  ).toContain('aria-current="page"')
})

test('the pending link exposes its loading indicator', () => {
  const idle = renderToStaticMarkup(
    <JurisdictionCard jurisdiction={jurisdiction} />
  )
  expect(idle).not.toContain('data-navigation-pending')
  expect(idle).not.toContain('animate-spin')
  expect(idle).not.toContain('role="status"')
  route.pending = true
  const html = renderToStaticMarkup(
    <JurisdictionCard jurisdiction={jurisdiction} />
  )
  expect(html).toContain('data-navigation-pending')
  expect(html).toContain('role="status"')
  expect(html).toContain('Loading')
  expect(html).toContain('animate-spin')
})

test('jurisdiction links preserve the selected Batch', () => {
  route.query = 'batch=shared'
  expect(
    renderToStaticMarkup(<JurisdictionCard jurisdiction={jurisdiction} />)
  ).toContain('href="/states/AL?batch=shared"')
})
