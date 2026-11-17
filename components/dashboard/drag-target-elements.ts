import type { DragFamily, TargetRect } from './drop-targets'

export function createStableDragTargets() {
  const rects = new Map<string, TargetRect>()
  return (targets: TargetRect[], scrollX: number, scrollY: number) => {
    const occurrences = new Map<string, number>()
    for (const { target, rect, scrollElement } of targets) {
      const identity = target.kind === 'family-slot' ? `family:${target.index}` : target.kind === 'variant-slot' ? `variant:${target.familyId}:${target.index}` : `merge:${target.familyId}`
      const occurrence = occurrences.get(identity) ?? 0
      occurrences.set(identity, occurrence + 1)
      const key = `${identity}:${occurrence}`
      if (!rects.has(key) || rects.get(key)?.scrollElement !== scrollElement) rects.set(key, { target, scrollElement, rect: { left: rect.left + scrollX + (scrollElement?.scrollLeft ?? 0), right: rect.right + scrollX + (scrollElement?.scrollLeft ?? 0), top: rect.top + scrollY + (scrollElement?.scrollTop ?? 0), bottom: rect.bottom + scrollY + (scrollElement?.scrollTop ?? 0) } })
    }
    return Array.from(rects.values(), ({ target, rect, scrollElement }) => {
      const clip = scrollElement?.getBoundingClientRect()
      return { target, rect: { left: Math.max(rect.left - scrollX - (scrollElement?.scrollLeft ?? 0), clip?.left ?? -Infinity), right: Math.min(rect.right - scrollX - (scrollElement?.scrollLeft ?? 0), clip?.right ?? Infinity), top: Math.max(rect.top - scrollY - (scrollElement?.scrollTop ?? 0), clip?.top ?? -Infinity), bottom: Math.min(rect.bottom - scrollY - (scrollElement?.scrollTop ?? 0), clip?.bottom ?? Infinity) } }
    })
  }
}

export function collectDragTargets(root: HTMLElement | null, families: DragFamily[]): TargetRect[] {
  if (!root) return []
  const targets: TargetRect[] = []
  for (const element of root.querySelectorAll<HTMLElement>('[data-drag-family]')) {
    const familyId = element.dataset.dragFamily
    const index = families.findIndex(family => family.template.id === familyId)
    if (index < 0 || families[index].template.deleted) continue
    const rect = element.getBoundingClientRect()
    const edge = Math.min(28, rect.width / 5)
    targets.push(
      { target: { kind: 'family-slot', index }, rect: { left: rect.left - 8, right: rect.left + edge, top: rect.top, bottom: rect.bottom } },
      { target: { kind: 'family-slot', index: index + 1 }, rect: { left: rect.right - edge, right: rect.right + 8, top: rect.top, bottom: rect.bottom } },
      { target: { kind: 'merge', familyId: familyId! }, rect: { left: rect.left + edge, right: rect.right - edge, top: rect.top, bottom: rect.bottom } },
    )
    for (const variant of element.querySelectorAll<HTMLElement>('[data-drag-variant]')) {
      const variantIndex = families[index].variants.findIndex(plate => plate.id === variant.dataset.dragVariant)
      if (variantIndex < 0 || families[index].variants[variantIndex].deleted) continue
      const bounds = variant.getBoundingClientRect()
      const scrollElement = variant.closest<HTMLElement>('[data-variant-scroll]') ?? undefined
      const midpoint = (bounds.top + bounds.bottom) / 2
      targets.push(
        { target: { kind: 'variant-slot', familyId: familyId!, index: variantIndex }, scrollElement, rect: { left: bounds.left, right: bounds.right, top: bounds.top - 6, bottom: scrollElement ? midpoint : bounds.top + 10 } },
        { target: { kind: 'variant-slot', familyId: familyId!, index: variantIndex + 1 }, scrollElement, rect: { left: bounds.left, right: bounds.right, top: scrollElement ? midpoint : bounds.bottom - 10, bottom: bounds.bottom + 6 } },
      )
    }
  }
  return targets
}
