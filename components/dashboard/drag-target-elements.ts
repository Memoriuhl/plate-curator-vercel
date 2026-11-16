import type { DragFamily, TargetRect } from './drop-targets'

export function collectDragTargets(root: HTMLElement | null, families: DragFamily[]): TargetRect[] {
  if (!root) return []
  const targets: TargetRect[] = []
  for (const element of root.querySelectorAll<HTMLElement>('[data-drag-family]')) {
    const familyId = element.dataset.dragFamily
    const index = families.findIndex(family => family.template.id === familyId)
    if (index < 0) continue
    const rect = element.getBoundingClientRect()
    const edge = Math.min(28, rect.width / 5)
    targets.push(
      { target: { kind: 'family-slot', index }, rect: { left: rect.left - 8, right: rect.left + edge, top: rect.top, bottom: rect.bottom } },
      { target: { kind: 'family-slot', index: index + 1 }, rect: { left: rect.right - edge, right: rect.right + 8, top: rect.top, bottom: rect.bottom } },
      { target: { kind: 'merge', familyId: familyId! }, rect: { left: rect.left + edge, right: rect.right - edge, top: rect.top, bottom: rect.bottom } },
    )
    for (const variant of element.querySelectorAll<HTMLElement>('[data-drag-variant]')) {
      const variantIndex = families[index].variants.findIndex(plate => plate.id === variant.dataset.dragVariant)
      if (variantIndex < 0) continue
      const bounds = variant.getBoundingClientRect()
      targets.push(
        { target: { kind: 'variant-slot', familyId: familyId!, index: variantIndex }, rect: { left: bounds.left, right: bounds.right, top: bounds.top - 6, bottom: bounds.top + 10 } },
        { target: { kind: 'variant-slot', familyId: familyId!, index: variantIndex + 1 }, rect: { left: bounds.left, right: bounds.right, top: bounds.bottom - 10, bottom: bounds.bottom + 6 } },
      )
    }
  }
  return targets
}
