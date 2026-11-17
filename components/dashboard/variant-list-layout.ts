export const VARIANT_ROW_HEIGHT = 66
export const VARIANT_ROW_GAP = 12

export function variantListCap(rows: { start: number; size: number }[]) {
  return rows.length >= 6 ? rows[5].start - rows[0].start + rows[5].size / 2 : undefined
}

export function estimatedFamilyHeight(variantCount: number) {
  return 190 + (variantCount ? 24 : 0) + Math.min(variantCount, 5.5) * VARIANT_ROW_HEIGHT + Math.min(Math.max(variantCount - 1, 0), 5) * VARIANT_ROW_GAP
}

export function revealVariantRow(list: HTMLElement, row: HTMLElement) {
  const bounds = list.getBoundingClientRect()
  const rect = row.getBoundingClientRect()
  if (rect.top < bounds.top) list.scrollTop -= bounds.top - rect.top
  else if (rect.bottom > bounds.top + list.clientHeight) list.scrollTop += rect.bottom - bounds.top - list.clientHeight
}
