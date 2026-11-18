export const VARIANT_ROW_HEIGHT = 62
export const VARIANT_ROW_GAP = 8

/**
 * Cap long variant lists halfway through the sixth row to signal that more rows can
 * scroll.
 */
export function variantListCap(rows: { start: number; size: number }[]) {
  return rows.length >= 6
    ? rows[5].start - rows[0].start + rows[5].size / 2
    : undefined
}

/** Estimate a family card's height while accounting for the visible cap on variants. */
export function estimatedFamilyHeight(variantCount: number) {
  return (
    102 +
    (variantCount ? 24 : 0) +
    Math.min(variantCount, 5.5) * VARIANT_ROW_HEIGHT +
    Math.min(Math.max(variantCount - 1, 0), 5) * VARIANT_ROW_GAP
  )
}

/** Scroll the focused variant row into view within its own list. */
export function revealVariantRow(list: HTMLElement, row: HTMLElement) {
  const bounds = list.getBoundingClientRect()
  const rect = row.getBoundingClientRect()
  if (rect.top < bounds.top) list.scrollTop -= bounds.top - rect.top
  else if (rect.bottom > bounds.top + list.clientHeight)
    list.scrollTop += rect.bottom - bounds.top - list.clientHeight
}
