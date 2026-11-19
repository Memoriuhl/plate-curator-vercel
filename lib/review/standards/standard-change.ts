import type { StandardChange } from '../types'

/**
 * Parse an optional standard-plate transition and distinguish missing from malformed
 * input.
 */
export function parseStandardChange(
  value: unknown
): StandardChange | undefined | null {
  if (value === undefined) return undefined
  if (
    !value ||
    typeof value !== 'object' ||
    !('from' in value) ||
    !('to' in value)
  )
    return null
  return (value.from === null || typeof value.from === 'string') &&
    typeof value.to === 'string'
    ? { from: value.from, to: value.to }
    : null
}
