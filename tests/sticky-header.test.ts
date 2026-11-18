import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')

test('header stays above content and below overlays', () => {
  const header = css.match(/\.app-header\s*\{([^}]+)\}/)?.[1] ?? ''
  expect(header).toMatch(/position:\s*sticky/)
  expect(header).toMatch(/top:\s*0;/)
  expect(header).toMatch(/z-index:\s*40;/)
  expect(header).toContain('background: var(--card)')
  expect(header).toContain('var(--hairline)')
})

test('scrolling, sidebar and review share the header height', () => {
  expect(css).toContain('scroll-padding-top: var(--header-h)')
  const sidebar =
    css.match(
      /\.states-layout > \.jurisdiction-strip,\s*\.states-layout > \.skeleton-jurisdictions\s*\{([^}]+)\}/
    )?.[1] ?? ''
  expect(sidebar).toContain('top: calc(var(--header-h) + var(--space-6))')
  expect(sidebar).toContain(
    'height: calc(100dvh - var(--header-h) - var(--space-6) * 2)'
  )
  expect(sidebar).not.toContain('64px')
  for (const file of [
    '../components/review/workspace.tsx',
    '../app/(curator)/review/page.tsx',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    expect(source).toContain('100dvh-var(--header-h)-var(--space-6)*2')
    expect(source).not.toContain('100dvh-112px')
  }
})

test('window virtualizer reads its scroll padding from the header height', () => {
  const source = readFileSync(
    new URL('../components/dashboard/family-grid.tsx', import.meta.url),
    'utf8'
  )
  expect(source.replace(/\s+/g, '')).toContain(
    "scrollPaddingStart:typeofdocument==='undefined'?0:" +
      "Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h'))"
  )
})
