export function variantListCap(rows: { start: number; size: number }[]) {
  return rows.length >= 6 ? rows[5].start - rows[0].start + rows[5].size / 2 : undefined
}

export function estimatedFamilyHeight(variantCount: number) {
  return 210 + (variantCount ? 12 : 0) + Math.min(variantCount, 5.5) * 104
}

export function revealVariantRow(list: HTMLElement, row: HTMLElement) {
  const bounds = list.getBoundingClientRect()
  const rect = row.getBoundingClientRect()
  if (rect.top < bounds.top) list.scrollTop -= bounds.top - rect.top
  else if (rect.bottom > bounds.top + list.clientHeight) list.scrollTop += rect.bottom - bounds.top - list.clientHeight
}
