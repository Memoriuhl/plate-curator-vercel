import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const css = readFileSync('app/globals.css', 'utf8')
const tokens = readFileSync('design-system/tokens.css', 'utf8')

/** Convert a hex color to relative luminance for the focus ring contrast test. */
function luminance(hex: string) {
  const channels = hex.match(/[a-f\d]{2}/gi)!.map((channel) => {
    const value = parseInt(channel, 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

test('search focus surrounds the whole field for every focus method', () => {
  const focus = css.match(/\.dashboard-search:focus-within\s*\{([^}]+)\}/)?.[1]
  expect(focus).toContain('box-shadow:')
  expect(focus).toContain('var(--ink-2)')
  expect(focus).toContain('background:')
  expect(css).toMatch(/\.dashboard-search input:focus\s*\{[^}]*outline: none/)
})

test('focus ring contrasts with the surrounding ground in every theme', () => {
  const themes = [
    ...tokens.matchAll(
      /--ground:\s*(#[a-f\d]+);([\s\S]*?)--ink-2:\s*(#[a-f\d]+);/gi
    ),
  ]
  expect(themes.length).toBeGreaterThanOrEqual(2)
  for (const [, ground, , ink] of themes) {
    const values = [luminance(ground), luminance(ink)].sort((a, b) => b - a)
    expect((values[0] + 0.05) / (values[1] + 0.05)).toBeGreaterThanOrEqual(3)
  }
})
