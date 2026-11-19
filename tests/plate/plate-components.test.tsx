vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  /** Capture or stub navigation so the test can drive routing without Next.js. */ useRouter:
    () => ({ prefetch: vi.fn() }),
}))
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { StatusIcon } from '../../components/plate/status-icon'
import { CheckStrip } from '../../components/plate/check-strip'
import { RarityMark } from '../../components/plate/rarity-mark'
import { PlateRow } from '../../components/plate/plate-row'
import { FamilyCard } from '../../components/plate/family-card'
import PlatesPreview from '../../app/(curator)/dev/plates/page'
import { plateCards } from '../../fixtures/plate-cards'
import { PLATE_CHECK_KEYS } from '../../lib/catalog/dashboard-types'

describe('StatusIcon', () => {
  test.each(['good', 'weak', 'missing'] as const)(
    'names the %s status accessibly',
    (status) => {
      const html = renderToStaticMarkup(
        <StatusIcon
          checkKey="tags"
          check={{ status, value: 'Full tag value' }}
        />
      )
      expect(html).toContain(`aria-label="Tags: ${status}"`)
      expect(html).toContain('role="img"')
      expect(html).not.toContain('<button')
      expect(html).not.toContain('data-status-dot')
      expect(html.includes('data-status-slash')).toBe(status === 'missing')
      expect(html).toContain('data-check="tags"')
      expect(html).not.toContain('title=')
    }
  )
})

test('CheckStrip preserves the seven contract checks in decision order', () => {
  const html = renderToStaticMarkup(
    <CheckStrip checks={plateCards[0].checks} />
  )
  const labels = [
    'Description',
    'Fun facts',
    'Link',
    'Tags',
    'Family',
    'Image',
    'Rarity',
  ]
  expect(PLATE_CHECK_KEYS).toHaveLength(7)
  expect(html).toContain('flex-nowrap')
  expect(html).not.toContain('flex-wrap')
  const offsets = labels.map((label) => html.indexOf(`aria-label="${label}:`))
  expect(offsets.every((offset) => offset >= 0)).toBe(true)
  expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
})

describe('RarityMark', () => {
  test('renders the missing catalog state without implying an estimate', () => {
    const html = renderToStaticMarkup(<RarityMark />)
    expect(html).toContain('Rarity: not available')
    expect(html).not.toContain('Estimated')
  })
  test.each(['Estimated', 'Observed', 'Manual'] as const)(
    'labels %s and uses the tier token',
    (source) => {
      const html = renderToStaticMarkup(<RarityMark tier={4} source={source} />)
      expect(html).toContain(`Long Hauler · ${source}`)
      expect(html).toContain('var(--rarity-4)')
      expect(html.includes('border-dashed')).toBe(source === 'Manual')
    }
  )
})

describe('PlateRow', () => {
  test('preserves the full long name and mono id with all checks', () => {
    const plate = plateCards[7]
    const html = renderToStaticMarkup(<PlateRow plate={plate} />)
    expect(html).toContain(plate.displayName)
    expect(html).toContain(plate.id)
    expect(html).toContain('font-mono')
    expect(html).not.toMatch(/truncate|line-clamp/)
    expect(html.match(/role="img"/g)).toHaveLength(7)
    expect(html).toContain('No image')
  })
  test('draws a fixed-size thumbnail regardless of the source image size', () => {
    const html = renderToStaticMarkup(<PlateRow plate={plateCards[0]} />)
    expect(html).toContain('width="72" height="36"')
    expect(html).toContain('width:72px;height:36px')
    expect(html).toContain('object-contain')
  })
})

describe('FamilyCard', () => {
  test('renders a singleton with Standard star and native image dragging disabled', () => {
    const html = renderToStaticMarkup(
      <FamilyCard template={plateCards[0]} variants={[]} />
    )
    expect(html).toContain('aria-label="Standard plate"')
    expect(html).toContain('width="140" height="70"')
    expect(html.match(/role="img"/g)).toHaveLength(7)
    expect(html.match(/draggable="false"/g)).toHaveLength(2)
    expect(html).not.toContain('draggable="true"')
  })
  test('renders all six family members and the grouping note', () => {
    const members = plateCards.slice(1, 7)
    const html = renderToStaticMarkup(
      <FamilyCard
        template={members[0]}
        variants={members.slice(1)}
        groupingNote="Shared veterans base"
      />
    )
    for (const member of members) expect(html).toContain(member.displayName)
    expect(html).toContain('width="84" height="42"')
    expect(html).toContain('Shared veterans base')
    expect(html.match(/aria-label="Plate checks"/g)).toHaveLength(6)
  })
})

test('fixtures cover all states, missing images, and real catalog identities', () => {
  expect(
    new Set(
      plateCards.flatMap((plate) =>
        Object.values(plate.checks).map((check) => check.status)
      )
    )
  ).toEqual(new Set(['good', 'weak', 'missing']))
  expect(plateCards.some((plate) => plate.imageUrl === null)).toBe(true)
  expect(
    plateCards.every((plate) => plate.checks.rarity.status === 'missing')
  ).toBe(true)
})

test('preview returns not found in production', () => {
  vi.stubEnv('NODE_ENV', 'production')
  try {
    expect(() => PlatesPreview()).toThrow('NEXT_HTTP_ERROR_FALLBACK;404')
  } finally {
    vi.unstubAllEnvs()
  }
})

test('plate images skip the optimizer because the source files are already pre-sized', () => {
  const plate = {
    ...plateCards[0],
    imageUrl: 'https://example.com/AK/standard_gold.webp',
  }
  for (const html of [
    renderToStaticMarkup(<PlateRow plate={plate} />),
    renderToStaticMarkup(<FamilyCard template={plate} variants={[]} />),
  ]) {
    expect(html).toContain('src="https://example.com/AK/standard_gold.webp"')
    expect(html).toContain('loading="lazy"')
  }
})

test('every check tier fits seven icons and their gaps in its narrowest width', () => {
  const css = readFileSync('app/globals.css', 'utf8')
  const base = css.match(
    /\.family-plate-details \[data-check-strip\] \{\s*gap: (\d+)px;/
  )!
  const tiers = [
    ...css.matchAll(
      /@container plate-checks \(width < (\d+)px\) \{([\s\S]*?)\n\}/g
    ),
  ].map(([, below, body]) => ({
    below: Number(below),
    icon: body.match(/width: (\d+)px/)?.[1],
    gap: body.match(/gap: (\d+)px/)?.[1],
  }))
  const details = css.match(
    /\.family-plate-details \{[\s\S]*?min-width: (\d+)px;[\s\S]*?padding-right: (\d+)px;/
  )!
  let icon = 20
  let gap = Number(base[1])
  const steps = [{ min: tiers[0].below, icon, gap }]
  tiers.forEach((tier, index) => {
    icon = tier.icon ? Number(tier.icon) : icon
    gap = tier.gap ? Number(tier.gap) : gap
    steps.push({
      min: tiers[index + 1]?.below ?? Number(details[1]) - Number(details[2]),
      icon,
      gap,
    })
  })
  for (const step of steps)
    expect(
      PLATE_CHECK_KEYS.length * step.icon +
        (PLATE_CHECK_KEYS.length - 1) * step.gap
    ).toBeLessThanOrEqual(step.min)
  expect(Math.min(...steps.map((step) => step.gap))).toBeGreaterThanOrEqual(2)
})

test('every plate keeps its title and checks together beside the image', () => {
  const html = renderToStaticMarkup(
    <FamilyCard template={plateCards[0]} variants={[plateCards[1]]} />
  )
  expect(html).not.toContain('flex-wrap')
  expect(html).not.toContain('flex-col @min-')
  expect(html).toContain('lang="en"')
  expect(html).toContain('plate-name min-w-0 flex-1 truncate text-[15px]')
  expect(html).toContain('plate-name min-w-0 flex-1 truncate text-[13px]')
  expect(html).not.toContain('[overflow-wrap:anywhere]')
})

test('narrow cards shrink the image and leave icon sizing to the check tiers', () => {
  const css = readFileSync('app/globals.css', 'utf8')
  const narrow = css.match(
    /@container family-card \(width < 328px\) \{([\s\S]*?)\n\}/
  )![1]
  expect(narrow).toContain('--family-image-width')
  expect(narrow).not.toContain('[data-check]')
  expect(css).toMatch(/\[data-check\] \{\s*cursor: help;/)
})
