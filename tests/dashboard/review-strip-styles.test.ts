import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const css = readFileSync('app/globals.css', 'utf8')

test('review state lists truncate within one line', () => {
  const states = css.match(/\.review-states\s*\{([^}]+)\}/)?.[1]
  expect(states).toContain('max-width: 12ch')
  expect(states).toContain('white-space: nowrap')
  expect(states).toContain('overflow: hidden')
  expect(states).toContain('text-overflow: ellipsis')
})
