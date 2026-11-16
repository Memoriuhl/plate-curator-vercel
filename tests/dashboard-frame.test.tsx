import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, test, vi } from 'vitest'
import { dashboardFixture, alaskaFixture } from '../fixtures/dashboard-frame'
import { JurisdictionCard } from '../components/dashboard/jurisdiction-card'
import { FilterBarControls } from '../components/dashboard/filter-bar'

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  query: 'q=gold',
  pathname: '/states/AK',
}))
const toggles = vi.hoisted(
  () => new Map<string, { onPressedChange: (pressed: boolean) => void }>(),
)
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: navigation.replace }),
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.query),
}))
vi.mock('../components/ui/toggle', () => ({
  Toggle: (
    props: ComponentProps<'button'> & {
      count: number
      pressed: boolean
      onPressedChange: (pressed: boolean) => void
    },
  ) => {
    const label = Array.isArray(props.children)
      ? String(props.children.at(-1))
      : String(props.children)
    toggles.set(label, props)
    return (
      <button aria-pressed={props.pressed}>
        {props.children}
        <span>{props.count}</span>
      </button>
    )
  },
}))

beforeEach(() => {
  navigation.replace.mockClear()
  navigation.query = 'q=gold'
  toggles.clear()
})

test('jurisdiction card exposes selected border, destination, counts and proportional progress', () => {
  const jurisdiction = {
    ...dashboardFixture.jurisdictions[0],
    completeCount: 11,
  }
  const html = renderToStaticMarkup(
    <JurisdictionCard jurisdiction={jurisdiction} selected />,
  )
  expect(html).toContain('jurisdiction-selected')
  expect(html).toContain('aria-current="page"')
  expect(html).toContain('href="/states/AK"')
  expect(html).toContain('11/44 complete')
  expect(html).toContain('width:25%')
  const unselected = renderToStaticMarkup(
    <JurisdictionCard jurisdiction={jurisdiction} selected={false} />,
  )
  expect(unselected).not.toContain('aria-current')
  expect(unselected).not.toContain('jurisdiction-selected')
})

test('filter bar renders fixture check counts and preserves query when selecting a filter', () => {
  const html = renderToStaticMarkup(
    <FilterBarControls plates={alaskaFixture.plates} changedCount={3} />,
  )
  expect(html).toContain('All plates<span>44</span>')
  expect(html).toContain('Changed in a batch<span>3</span>')
  expect(html).toContain('No fun facts<span>44</span>')
  expect(html).toContain('Under-tagged<span>0</span>')
  expect(html).toContain('Generic description<span>2</span>')
  toggles.get('Under-tagged')!.onPressedChange(true)
  expect(navigation.replace).toHaveBeenCalledWith(
    '/states/AK?q=gold&show=undertagged',
    { scroll: false },
  )
})

test('URL selects one chip and empty plates have zero counts', () => {
  navigation.query = 'show=generic'
  const html = renderToStaticMarkup(
    <FilterBarControls plates={[]} changedCount={0} />,
  )
  expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
  expect(html).toContain('Generic description<span>0</span>')
  toggles.get('All plates')!.onPressedChange(true)
  expect(navigation.replace).toHaveBeenCalledWith('/states/AK?show=all', {
    scroll: false,
  })
})

test('needs-work counts include weak and missing metadata', () => {
  const plates = structuredClone(alaskaFixture.plates.slice(0, 3))
  plates[0].checks.tags.status = 'weak'
  plates[1].checks.tags.status = 'missing'
  plates[2].checks.tags.status = 'good'
  plates[0].checks.description.status = 'weak'
  plates[1].checks.description.status = 'missing'
  plates[2].checks.description.status = 'good'
  plates[0].checks.funFacts.status = 'good'
  const html = renderToStaticMarkup(
    <FilterBarControls plates={plates} changedCount={0} />,
  )
  expect(html).toContain('Under-tagged<span>2</span>')
  expect(html).toContain('Generic description<span>2</span>')
  expect(html).toContain('No fun facts<span>2</span>')
})
