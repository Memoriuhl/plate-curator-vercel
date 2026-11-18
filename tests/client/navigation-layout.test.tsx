import { useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { JurisdictionSummary } from '@/lib/catalog/dashboard-types'
import { ThemeToggle } from '@/components/app/theme-toggle'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

const mounted = vi.hoisted(() => ({ strip: 0, review: 0, search: 0, code: 'AK' as string | undefined, id: undefined as string | undefined, pathname: '/states/AK', query: '', push: vi.fn(), prefetch: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mounted.query),
  useParams: () => ({ code: mounted.code, id: mounted.id }),
  usePathname: () => mounted.pathname,
  useRouter: () => mounted,
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

vi.mock('@/components/dashboard/selected-batch-bar', () => ({ SelectedBatchBar: () => null }))

vi.mock('@/lib/client/session', () => ({ useSession: () => ({ user: null, api: {} }) }))

const { default: StatesLayout } = await import('@/app/(curator)/states/layout')
const { useParams } = await import('next/navigation')

function StatePage() {
  const { code } = useParams()
  return <p>{code}</p>
}

afterEach(() => { cleanup(); vi.useRealTimers() })

beforeEach(() => {
  mounted.code = 'AK'
  mounted.id = undefined
  mounted.pathname = '/states/AK'
  mounted.query = ''
  mounted.push.mockClear()
  mounted.prefetch.mockClear()
  mounted.replace.mockReset()
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
  const pipeline = screen.getByRole('region', { name: 'Plate Pipeline' })
  const state = screen.getByText('AK')
  expect(pipeline.closest('.states-pipeline')?.nextElementSibling).toBe(state.closest('.states-content'))
  mounted.code = 'AL'
  view.rerender(<StatesLayout><StatePage key={mounted.code} /></StatesLayout>)
  expect(screen.getByText('AL')).toBeTruthy()
  expect(screen.getByRole('navigation')).toBe(strip)
  expect(screen.getByRole('textbox')).toBe(search)
  expect(screen.getByRole('region', { name: 'Plate Pipeline' })).toBe(pipeline)
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

const { DashboardSearch: ActualDashboardSearch } = await vi.importActual<typeof import('@/components/dashboard/search')>('@/components/dashboard/search')

function searchHarness(query = '') {
  vi.useFakeTimers()
  mounted.query = query
  const requests: { href: string; commit(): Promise<void> }[] = []
  const view = render(<ActualDashboardSearch />)
  const input = screen.getByRole('searchbox', { name: 'Search every plate by name, id or tag' }) as HTMLInputElement
  expect(input.value).toBe(new URLSearchParams(query).get('q') ?? '')
  mounted.replace.mockImplementation((href: string) => {
    let release!: () => void
    const committed = new Promise<void>(resolve => { release = resolve }).then(() => {
      const url = new URL(href, window.location.origin)
      mounted.pathname = url.pathname
      mounted.query = url.search.slice(1)
      view.rerender(<ActualDashboardSearch />)
    })
    requests.push({ href, commit: async () => { await act(async () => { release(); await committed }) } })
  })
  return {
    input,
    requests,
    type(text: string) {
      for (const character of text) fireEvent.change(input, { target: { value: input.value + character } })
    },
    async publish() { await act(async () => { await vi.advanceTimersByTimeAsync(300) }) },
    external(nextQuery: string, nextPathname = mounted.pathname) {
      mounted.pathname = nextPathname
      mounted.query = nextQuery
      view.rerender(<ActualDashboardSearch />)
    },
    popstate(nextQuery: string) {
      window.history.replaceState(null, '', `${mounted.pathname}${nextQuery ? `?${nextQuery}` : ''}`)
      fireEvent.popState(window)
      mounted.query = nextQuery
      view.rerender(<ActualDashboardSearch />)
    },
    unmount: view.unmount,
  }
}

test('search keeps every fast character before the router commits and coalesces the URL update', async () => {
  const search = searchHarness('batch=shared&show=undertagged&custom=keep')
  search.type('motorcycle')
  expect(search.input.value).toBe('motorcycle')
  await search.publish()
  expect(search.requests).toHaveLength(1)
  expect(search.requests[0].href).toBe('/states/AK?batch=shared&show=undertagged&custom=keep&q=motorcycle')
  expect(new URLSearchParams(mounted.query).has('q')).toBe(false)
  await search.requests[0].commit()
  expect(search.input.value).toBe('motorcycle')
  expect(new URLSearchParams(mounted.query).get('q')).toBe('motorcycle')
  await search.publish()
  expect(search.requests).toHaveLength(1)
  expect(mounted.replace).toHaveBeenCalledWith(search.requests[0].href, { scroll: false })
})

test('older search acknowledgements cannot replace newer typing and out-of-order commits converge', async () => {
  const search = searchHarness()
  search.type('a')
  await search.publish()
  expect(search.requests).toHaveLength(1)
  search.type('r')
  await search.publish()
  expect(search.requests).toHaveLength(2)
  search.type('m')
  await search.requests[1].commit()
  expect(search.input.value).toBe('arm')
  await search.publish()
  expect(search.requests).toHaveLength(3)
  await search.requests[2].commit()
  expect(search.input.value).toBe('arm')
  await search.requests[0].commit()
  expect(new URLSearchParams(mounted.query).get('q')).toBe('a')
  expect(search.input.value).toBe('arm')
  await search.publish()
  expect(search.requests).toHaveLength(4)
  await search.requests[3].commit()
  expect(new URLSearchParams(mounted.query).get('q')).toBe('arm')
  await search.publish()
  expect(search.requests).toHaveLength(4)
})

test('search Backspace and clear remove q while preserving Batch, other params, and scroll', async () => {
  const search = searchHarness('q=army&batch=shared&custom=one&custom=two')
  fireEvent.change(search.input, { target: { value: search.input.value.slice(0, -1) } })
  expect(search.input.value).toBe('arm')
  await search.publish()
  expect(search.requests).toHaveLength(1)
  await search.requests[0].commit()
  expect(new URLSearchParams(mounted.query).get('q')).toBe('arm')
  fireEvent.change(search.input, { target: { value: '' } })
  expect(search.input.value).toBe('')
  await search.publish()
  expect(search.requests).toHaveLength(2)
  expect(search.requests[1].href).toBe('/states/AK?batch=shared&custom=one&custom=two')
  await search.requests[1].commit()
  expect(new URLSearchParams(mounted.query).has('q')).toBe(false)
  expect(new URLSearchParams(mounted.query).getAll('custom')).toEqual(['one', 'two'])
  for (const call of mounted.replace.mock.calls) expect(call[1]).toEqual({ scroll: false })
})

test('external search navigation replaces the draft and cancels an unpublished edit', async () => {
  const search = searchHarness('q=army&batch=shared')
  search.type(' truck')
  search.external('q=motorcycle&batch=shared&show=all')
  expect(search.input.value).toBe('motorcycle')
  await search.publish()
  expect(search.requests).toHaveLength(0)
  search.external('q=army&batch=shared')
  expect(search.input.value).toBe('army')
  search.external('batch=shared')
  expect(search.input.value).toBe('')
  await search.publish()
  expect(search.requests).toHaveLength(0)
})

test('external navigation can revisit acknowledged search values and retains the latest other params', async () => {
  const search = searchHarness('q=army&batch=shared')
  fireEvent.change(search.input, { target: { value: 'motorcycle' } })
  await search.publish()
  await search.requests[0].commit()
  search.external('q=army&batch=other&custom=keep')
  expect(search.input.value).toBe('army')
  search.external('q=motorcycle&batch=other&custom=keep')
  expect(search.input.value).toBe('motorcycle')
  fireEvent.change(search.input, { target: { value: '' } })
  await search.publish()
  expect(search.requests[1].href).toBe('/states/AK?batch=other&custom=keep')
})

test('search slash shortcut focuses only from outside editable fields and cleans up on unmount', () => {
  const search = searchHarness()
  expect(document.activeElement).not.toBe(search.input)
  fireEvent.keyDown(document.body, { key: '/', ctrlKey: true })
  expect(document.activeElement).not.toBe(search.input)
  fireEvent.keyDown(document.body, { key: '/' })
  expect(document.activeElement).toBe(search.input)
  const textarea = document.createElement('textarea')
  document.body.append(textarea)
  try {
    textarea.focus()
    fireEvent.keyDown(textarea, { key: '/' })
    expect(document.activeElement).toBe(textarea)
    const focus = vi.spyOn(search.input, 'focus')
    search.unmount()
    fireEvent.keyDown(document.body, { key: '/' })
    expect(focus).not.toHaveBeenCalled()
    focus.mockRestore()
  } finally {
    textarea.remove()
  }
})

test('back/forward overrides a pending own value and cancels newer unpublished typing', async () => {
  const initialUrl = window.location.href
  const search = searchHarness('q=a&batch=shared')
  try {
    search.type('r')
    await search.publish()
    expect(search.requests).toHaveLength(1)
    expect(new URL(search.requests[0].href, window.location.origin).searchParams.get('q')).toBe('ar')
    search.type('m')
    search.popstate('q=ar&batch=shared')
    expect(search.input.value).toBe('ar')
    await search.publish()
    expect(search.requests).toHaveLength(1)
  } finally {
    window.history.replaceState(null, '', initialUrl)
  }
})

test.each(['motorcycle', 'army'])('the latest external route and params survive an outstanding own acknowledgement with q=%s', async query => {
  const search = searchHarness('batch=A')
  search.type('army')
  await search.publish()
  expect(search.requests[0].href).toBe('/states/AK?batch=A&q=army')
  search.external(`q=${query}&batch=B&custom=keep`, '/states/CO')
  expect(search.input.value).toBe(query)
  await search.requests[0].commit()
  expect(search.input.value).toBe(query)
  await search.publish()
  expect(search.requests).toHaveLength(2)
  expect(search.requests[1].href).toBe(`/states/CO?q=${query}&batch=B&custom=keep`)
  expect(mounted.replace).toHaveBeenLastCalledWith(search.requests[1].href, { scroll: false })
  await search.requests[1].commit()
  expect(mounted.pathname).toBe('/states/CO')
  expect(Object.fromEntries(new URLSearchParams(mounted.query))).toEqual({ q: query, batch: 'B', custom: 'keep' })
  await search.publish()
  expect(search.requests).toHaveLength(2)
})

test('Backspace through the final character removes q and leaves the bare pathname', async () => {
  const search = searchHarness('q=ar')
  while (search.input.value) fireEvent.change(search.input, { target: { value: search.input.value.slice(0, -1) } })
  expect(search.input.value).toBe('')
  await search.publish()
  expect(search.requests).toHaveLength(1)
  expect(search.requests[0].href).toBe('/states/AK')
  await search.requests[0].commit()
  expect(new URLSearchParams(mounted.query).has('q')).toBe(false)
})

test('unmount cancels an unpublished search navigation', async () => {
  const search = searchHarness('batch=shared')
  search.type('army')
  search.unmount()
  await search.publish()
  expect(search.requests).toHaveLength(0)
})

test('a query from a canceled own navigation can be typed and published again', async () => {
  const search = searchHarness('batch=shared')
  search.type('army')
  await search.publish()
  search.external('q=motorcycle&batch=shared')
  expect(search.input.value).toBe('motorcycle')
  fireEvent.change(search.input, { target: { value: 'army' } })
  await search.publish()
  expect(search.requests).toHaveLength(2)
  expect(new URL(search.requests[1].href, window.location.origin).searchParams.get('q')).toBe('army')
  await search.requests[1].commit()
  expect(search.input.value).toBe('army')
  expect(new URLSearchParams(mounted.query).get('q')).toBe('army')
})
