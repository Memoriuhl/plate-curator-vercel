import type { DragItem } from './drop-targets'

export type DragGeometry = {
  width: number
  height: number
  offsetX: number
  offsetY: number
  imageWidth: number
  imageHeight: number
}

/**
 * Find the drag source element for a family or variant, preferring the pointer's origin.
 */
export function dragElement(item: DragItem, origin?: EventTarget | null) {
  const selector =
    item.kind === 'family' ? '[data-drag-family]' : '[data-drag-variant]'
  return (
    (origin instanceof Element
      ? origin.closest<HTMLElement>(selector)
      : null) ??
    Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
      (element) =>
        (item.kind === 'family'
          ? element.dataset.dragFamily
          : element.dataset.dragVariant) === item.plate.id
    )
  )
}

/**
 * Measure the source and pointer offset so the drag preview starts in the right place.
 */
export function measureDragGeometry(
  item: DragItem,
  x: number,
  y: number,
  origin?: EventTarget | null
) {
  const element = dragElement(item, origin)
  const rect = element?.getBoundingClientRect()
  const image = element
    ?.querySelector('[data-plate-image]')
    ?.getBoundingClientRect()
  return {
    width: rect?.width || (item.kind === 'family' ? 220 : 180),
    height: rect?.height || (item.kind === 'family' ? 210 : 80),
    offsetX: rect ? x - rect.left : 0,
    offsetY: rect ? y - rect.top : 0,
    imageWidth: image?.width || (item.kind === 'family' ? 140 : 84),
    imageHeight: image?.height || (item.kind === 'family' ? 70 : 42),
  }
}
