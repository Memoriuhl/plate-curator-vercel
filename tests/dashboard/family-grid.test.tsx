vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  /** Capture or stub navigation so the test can drive routing without Next.js. */ useRouter:
    () => ({ prefetch: vi.fn() }),
}))
import {
  projectFamilyPlate,
  expandFamilyPlate,
  filterCounts,
} from '../../components/dashboard/family-grid/family-data'
import { describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { plateCards } from '../../fixtures/plate-cards'
import {
  groupFamilies,
  matchesPlate,
} from '../../components/dashboard/family-grid/family-data'
import { FamilyCard } from '../../components/plate/family-card'
import { PlateHoverContent } from '../../components/plate/plate-hover-card'

const base = plateCards[0]
const head = {
  ...base,
  id: 'head',
  templateRole: 'template' as const,
  templateFamily: 'family',
  sortOrder: 2,
}
const variant = {
  ...base,
  id: 'variant',
  templateRole: 'variant' as const,
  variantOfPlateId: 'head',
  sortOrder: 4,
}
const fallback = {
  ...variant,
  id: 'fallback',
  variantOfPlateId: null,
  templateFamily: 'family',
  sortOrder: 3,
}
const single = { ...base, id: 'single', templateRole: null, sortOrder: 1 }

test('groups explicit and family variants with ordered singletons without mutating input', () => {
  const input = [variant, head, single, fallback]
  const families = groupFamilies(input)
  expect(families.map((item) => item.template.id)).toEqual(['single', 'head'])
  expect(families[1].variants.map((item) => item.id)).toEqual([
    'fallback',
    'variant',
  ])
  expect(input[0]).toBe(variant)
})

describe('filters', () => {
  test.each(['all', 'changed', 'nofunfacts', 'undertagged', 'generic'])(
    '%s matches its definition',
    (show) => {
      const changed = new Set([base.id])
      const expected =
        show === 'nofunfacts'
          ? base.checks.funFacts.status === 'missing'
          : show === 'undertagged'
            ? base.checks.tags.status !== 'good'
            : show === 'generic'
              ? base.checks.description.status === 'weak'
              : true
      expect(matchesPlate(base, show, '', changed)).toBe(expected)
      if (show === 'changed')
        expect(matchesPlate(base, show, '', new Set())).toBe(false)
    }
  )
  test('searches name, id and tag ignoring case and combines with filters', () => {
    const plate = { ...base, tags: ['Searchable'] }
    for (const query of [
      plate.id.toUpperCase(),
      plate.displayName.toUpperCase(),
      'SEARCHABLE',
    ])
      expect(matchesPlate(plate, 'all', query, new Set())).toBe(true)
    expect(matchesPlate(plate, 'all', 'no such plate', new Set())).toBe(false)
    expect(matchesPlate(plate, 'changed', 'SEARCHABLE', new Set())).toBe(false)
  })
})

test('image and title links with nonfocusable status glyphs', () => {
  const html = renderToStaticMarkup(
    <FamilyCard
      template={head}
      variants={[variant]}
      number={1}
      onPreview={() => {}}
    />
  )
  expect(html.match(/<a /g)).toHaveLength(4)
  expect(html).toContain('href="/plates/head"')
  expect(html).not.toContain('aria-label="Preview ')
  expect(html.match(/tabindex="0"/g)).toHaveLength(2)
  expect(html.match(/role="img"/g)).toHaveLength(14)
})

test('hover preview contains identity, full description and fun facts, all checks and every tag', () => {
  const plate = {
    ...base,
    tags: ['one', 'two', 'three', 'four'],
    checks: {
      ...base.checks,
      funFacts: { status: 'good' as const, value: 'First fact\nSecond fact' },
    },
  }
  const html = renderToStaticMarkup(
    <PlateHoverContent plate={plate} parent="Parent" left={8} top={8} />
  )
  for (const value of [
    plate.displayName,
    plate.id,
    'variant of Parent',
    'Description',
    'Fun facts',
    'Link',
    'Tags',
    'Family',
    'Image',
    'Rarity',
    'four',
    '<li>First fact</li>',
    '<li>Second fact</li>',
    'Click to open',
  ])
    expect(html).toContain(value)
  if (plate.checks.description.value)
    expect(html).toContain(plate.checks.description.value)
  expect(html).not.toContain('h-[492px]')
  expect(html).not.toContain('+1')
})

test('explicit parent references support legacy templates without a role', () => {
  const families = groupFamilies([{ ...head, templateRole: null }, variant])
  expect(families).toHaveLength(1)
  expect(families[0].variants).toEqual([variant])
})

test('server projection contains only grid fields and check statuses, never full values', () => {
  const slim = projectFamilyPlate(base)
  expect(Object.keys(slim).sort()).toEqual(
    [
      'deleted',
      'id',
      'revision',
      'displayName',
      'imageUrl',
      'templateRole',
      'templateFamily',
      'variantOfPlateId',
      'isStandard',
      'sortOrder',
      'tags',
      'checks',
    ].sort()
  )
  expect(slim.checks.description).toBe(base.checks.description.status)
  expect(JSON.stringify(slim)).not.toContain('value')
  const expanded = expandFamilyPlate(slim)
  expect(expanded.checks.description).toEqual({
    status: base.checks.description.status,
    value: null,
  })
  expect(expanded.state).toBe(base.id.split('.')[0])
})

test('family projection round-trip preserves the server revision', () => {
  const plate = { ...base, revision: 'server-revision' }
  expect(expandFamilyPlate(projectFamilyPlate(plate)).revision).toBe(
    plate.revision
  )
})

test('server counts preserve every filter definition', () => {
  expect(filterCounts([base])).toMatchObject({
    all: 1,
    nofunfacts: Number(base.checks.funFacts.status === 'missing'),
    undertagged: Number(base.checks.tags.status !== 'good'),
    generic: Number(base.checks.description.status === 'weak'),
  })
})

test('large families server-render only a bounded variant window and retain the full list size', () => {
  const variants = Array.from({ length: 990 }, (_, index) => ({
    ...variant,
    id: `variant-${index}`,
  }))
  const html = renderToStaticMarkup(
    <FamilyCard template={head} variants={variants} />
  )
  const links = html.match(/data-plate-row=/g) ?? []
  expect(links.length).toBeGreaterThan(1)
  expect(links.length).toBeLessThan(15)
  expect(html).toContain('aria-setsize="990"')
  expect(html).not.toContain('href="/plates/variant-989"')
  expect(html).toContain('role="listitem"')
})

test('pending deletions remain in the family grid with an undo action', () => {
  const deleted = { ...head, deleted: true }
  expect(expandFamilyPlate(projectFamilyPlate(deleted)).deleted).toBe(true)
  const html = renderToStaticMarkup(
    <FamilyCard
      template={deleted}
      variants={[variant]}
      canEdit
      onUndoDelete={() => {}}
    />
  )
  expect(html).toContain('Undo delete')
  expect(html).toContain('line-through')
  expect(html).toContain(variant.displayName)
})
