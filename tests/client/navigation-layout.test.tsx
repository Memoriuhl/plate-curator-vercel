import { useEffect } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { JurisdictionSummary } from '@/lib/catalog/dashboard-types'
import { ThemeToggle } from '@/components/app/theme-toggle'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

const mounted = vi.hoisted(() => ({ strip: 0, review: 0, search: 0, code: 'AK' as string | undefined, id: undefined as string | undefined, pathname: '/states/AK', push: vi.fn(), prefetch: vi.fn() }))
vi.mock('next/navigation', () => ({
  useParams: () => ({ code: mounted.code, id: mounted.id }),
  usePathname: () => mounted.pathname,
  useRouter: () => ({ push: mounted.push, prefetch: mounted.prefetch }),
}))
vi.mock('next/link', () => ({
  default: ({ children, prefetch, scroll, ...props }: React.PropsWithChildren<Record<string, unknown>>) => {
    void scroll
    return <a {...props} data-prefetch={String(prefetch)}>{children}</a>
  },
  useLinkStatus: () => ({ pending: false }),
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, value, onValueChange }: React.PropsWithChildren<{ value: string; onValueChange(value: string): void }>) => (
    <select aria-label="Region" value={value} onChange={(event) => onValueChange(event.target.value)}>{children}</select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: React.PropsWithChildren) => children,
  SelectItem: ({ children, ...props }: React.PropsWithChildren<{ value: string; disabled: boolean }>) => <option {...props}>{children}</option>,
}))
vi.mock('@/components/dashboard/dashboard-data', () => ({
  JurisdictionStrip: function Strip() {
    useEffect(() => { mounted.strip++ }, [])
    return <nav aria-label="Jurisdictions">Jurisdictions</nav>
  },
}))
vi.mock('@/components/dashboard/search', () => ({
  DashboardSearch: function Search() {
    useEffect(() => { mounted.search++ }, [])
    return <input aria-label="Search" />
  },
}))
vi.mock('@/components/dashboard/review-strip', () => ({
  ReviewStrip: function Review() {
    useEffect(() => { mounted.review++ }, [])
    return <div>Review</div>
  },
}))

const { default: StatesLayout } = await import('@/app/(curator)/states/layout')
const { useParams } = await import('next/navigation')

function StatePage() {
  const { code } = useParams()
  return <p>{code}</p>
}

afterEach(cleanup)

beforeEach(() => {
  mounted.code = 'AK'
  mounted.id = undefined
  mounted.pathname = '/states/AK'
  mounted.push.mockClear()
  mounted.prefetch.mockClear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
test('appearance segments stay open, persist choices, and support arrow keys', () => {
  document.documentElement.removeAttribute('data-theme')
  localStorage.clear()
  render(<DropdownMenu defaultOpen><DropdownMenuTrigger>Profile</DropdownMenuTrigger><DropdownMenuContent><ThemeToggle /></DropdownMenuContent></DropdownMenu>)
  fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(localStorage.getItem('plate-curator-theme')).toBe('dark')
  expect(screen.getByRole('radiogroup', { name: 'Appearance' })).toBeTruthy()
  expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.keyDown(screen.getByRole('radio', { name: 'Dark' }), { key: 'ArrowLeft' })
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Light' }))
  fireEvent.keyDown(screen.getByRole('radio', { name: 'Light' }), { key: 'Home' })
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  expect(localStorage.getItem('plate-curator-theme')).toBe('system')
  fireEvent.keyDown(screen.getByRole('radio', { name: 'System' }), { key: 'ArrowLeft' })
  expect(document.documentElement.dataset.theme).toBe('dark')
  fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
  expect(document.documentElement.style.colorScheme).toBe('light')
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.style.removeProperty('color-scheme')
  localStorage.clear()
})

test('shared controls stay mounted when the router changes the state parameter', () => {
  const view = render(<StatesLayout><StatePage key={mounted.code} /></StatesLayout>)
  const strip = screen.getByRole('navigation')
  const search = screen.getByRole('textbox')
  mounted.code = 'AL'
  view.rerender(<StatesLayout><StatePage key={mounted.code} /></StatesLayout>)
  expect(screen.getByText('AL')).toBeTruthy()
  expect(screen.getByRole('navigation')).toBe(strip)
  expect(screen.getByRole('textbox')).toBe(search)
  expect(mounted.strip).toBe(1)
  expect(mounted.review).toBe(1)
  expect(mounted.search).toBe(1)
})

const { JurisdictionNav } = await import('@/components/dashboard/jurisdiction-nav')
const { CuratorHeader } = await import('@/components/app/curator-header')
const { RegionPill } = await import('@/components/app/region-pill')
const { summarizeRegions } = await import('@/components/app/regions')
vi.mock('@/components/app/header-actions', () => ({ HeaderActions: () => <div>Actions</div> }))
vi.mock('@/components/app/workspace-tabs', () => ({ WorkspaceTabs: () => <div>Tabs</div> }))

const jurisdictions = [
  { code: 'AK', name: 'Alaska', region: 'US' },
  { code: 'MD', name: 'Maryland', region: 'US' },
  { code: 'ON', name: 'Ontario', region: 'CA' },
  { code: 'BC', name: 'British Columbia', region: 'CA' },
].map((item) => ({ ...item, completeCount: 1, plateCount: 2, progress: null })) satisfies JurisdictionSummary[]

test('prefetches only two neighbors on each side and keeps viewport and intent prefetch', () => {
  const states = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT'].map(code => ({ ...jurisdictions[0], code, name: code }))
  mounted.code = 'AR'
  const view = render(<JurisdictionNav jurisdictions={[...states, jurisdictions[2]]} />)
  expect(mounted.prefetch.mock.calls.map(([href]) => href)).toEqual(['/states/AK', '/states/AZ', '/states/CA', '/states/CO'])
  expect(screen.getAllByRole('link').filter(link => link.dataset.prefetch === 'true').map(link => link.textContent?.slice(0, 2))).toEqual(['AK', 'AZ', 'CA', 'CO'])
  const distant = screen.getByRole('link', { name: /CT/ })
  expect(distant.dataset.prefetch).toBe('auto')
  fireEvent.mouseEnter(distant)
  expect(distant.dataset.prefetch).toBe('true')
  const first = screen.getByRole('link', { name: /AL/ })
  fireEvent.focus(first)
  expect(first.dataset.prefetch).toBe('true')
  mounted.prefetch.mockClear()
  mounted.code = 'AL'
  view.rerender(<JurisdictionNav jurisdictions={states} />)
  expect(mounted.prefetch.mock.calls.map(([href]) => href)).toEqual(['/states/AK', '/states/AZ'])
})

test('one navigation filters by URL region and keeps its DOM node across state switches', () => {
  const view = render(<JurisdictionNav jurisdictions={jurisdictions} />)
  const nav = screen.getByRole('navigation')
  expect(screen.getAllByRole('navigation')).toHaveLength(1)
  expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/states/AK', '/states/MD'])
  mounted.code = 'MD'
  view.rerender(<JurisdictionNav jurisdictions={jurisdictions} />)
  expect(screen.getByRole('navigation')).toBe(nav)
  mounted.code = 'ON'
  view.rerender(<JurisdictionNav jurisdictions={jurisdictions} />)
  expect(screen.getByRole('navigation')).toBe(nav)
  expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/states/ON', '/states/BC'])
  mounted.code = undefined
  mounted.id = 'BC.army'
  mounted.pathname = '/plates/BC.army'
  view.rerender(<JurisdictionNav jurisdictions={jurisdictions} />)
  expect(screen.getAllByRole('link')).toHaveLength(2)
  expect(screen.queryByText('Alaska')).toBeNull()
})

test('region options depend on availability and navigate to the first jurisdiction', () => {
  const view = render(<RegionPill regions={summarizeRegions(jurisdictions)} jurisdictions={jurisdictions} />)
  const select = screen.getByRole('combobox') as HTMLSelectElement
  expect(select.value).toBe('US')
  expect((screen.getByRole('option', { name: /Canada/ }) as HTMLOptionElement).disabled).toBe(false)
  expect((screen.getByRole('option', { name: /Mexico.*Coming soon/ }) as HTMLOptionElement).disabled).toBe(true)
  expect((screen.getByRole('option', { name: /Europe.*Coming soon/ }) as HTMLOptionElement).disabled).toBe(true)
  fireEvent.change(select, { target: { value: 'CA' } })
  expect(mounted.push).toHaveBeenCalledWith('/states/ON')
  mounted.code = undefined
  mounted.id = 'BC.army'
  mounted.pathname = '/plates/BC.army'
  view.rerender(<RegionPill regions={summarizeRegions(jurisdictions)} jurisdictions={jurisdictions} />)
  expect(select.value).toBe('CA')
  mounted.pathname = '/review'
  view.rerender(<RegionPill regions={summarizeRegions(jurisdictions)} jurisdictions={jurisdictions} />)
  expect(select.value).toBe('US')
})

test.each([
  ['column', 20, 80, null],
  ['column', -20, 40, { top: -20 }],
  ['column', 80, 140, { top: 40 }],
  ['row', 20, 80, null],
  ['row', -20, 40, { left: -20 }],
  ['row', 80, 140, { left: 40 }],
] as const)('selected card scrolls only its container when outside %s bounds %i..%i', (direction, start, end, expected) => {
  const scrollBy = vi.fn()
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'NAV'
      ? { top: 0, left: 0, bottom: 100, right: 100 } as DOMRect
      : { top: start, left: start, bottom: end, right: end } as DOMRect
  })
  const style = vi.spyOn(window, 'getComputedStyle').mockReturnValue({ flexDirection: direction } as CSSStyleDeclaration)
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
  const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
  HTMLElement.prototype.scrollBy = scrollBy
  render(<JurisdictionNav jurisdictions={jurisdictions} />)
  if (expected) expect(scrollBy).toHaveBeenCalledExactlyOnceWith(expected)
  else expect(scrollBy).not.toHaveBeenCalled()
  rect.mockRestore()
  style.mockRestore()
  width.mockRestore()
  height.mockRestore()
})


test('region switch is first in jurisdiction navigation and absent from the header', () => {
  const view = render(
    <JurisdictionNav jurisdictions={jurisdictions}>
      <RegionPill regions={summarizeRegions(jurisdictions)} jurisdictions={jurisdictions} />
    </JurisdictionNav>,
  )
  expect(screen.getByRole('navigation').firstElementChild?.contains(screen.getByRole('combobox'))).toBe(true)
  view.unmount()
  render(<CuratorHeader />)
  expect(screen.queryByRole('combobox')).toBeNull()
})
