/**
 * Scroll a capped variant list near its edges and report whether it consumed the drag
 * scroll.
 */
export function scrollDragList(x: number, y: number, familyId: string) {
  const list = Array.from(document.querySelectorAll<HTMLElement>('[data-variant-scroll]')).find(element => element.dataset.variantScroll === familyId)
  if (!list) return false
  const rect = list.getBoundingClientRect()
  const top = Math.max(0, rect.top)
  const bottom = Math.min(window.innerHeight, rect.bottom)
  if (x < rect.left || x > rect.right || y < top || y > bottom) return false
  const speed = y < top + 40 ? -Math.ceil(12 * (1 - (y - top) / 40)) : y > bottom - 40 ? Math.ceil(12 * (1 - (bottom - y) / 40)) : 0
  const before = list.scrollTop
  list.scrollTop += speed
  return list.scrollTop !== before
}
