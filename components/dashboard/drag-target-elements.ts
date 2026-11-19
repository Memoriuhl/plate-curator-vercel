import type { DragFamily, TargetRect } from './drop-targets'

/**
 * Cache drop rectangles for this drag so reflow animations can't move the hit areas.
 * Translate the saved bounds by the current scroll position during hit testing.
 */
export function createStableDragTargets() {
  const rects = new Map<string, TargetRect>()
  return (targets: TargetRect[], scrollX: number, scrollY: number) => {
    const occurrences = new Map<string, number>()
    for (const { target, rect, scrollElement } of targets) {
      const identity =
        target.kind === 'family-slot'
          ? JSON.stringify([
              'family',
              target.index,
              target.anchor?.anchorId,
              target.anchor?.kind,
            ])
          : target.kind === 'variant-slot'
            ? `variant:${target.familyId}:${target.index}`
            : `merge:${target.familyId}`
      const occurrence = occurrences.get(identity) ?? 0
      occurrences.set(identity, occurrence + 1)
      const key = `${identity}:${occurrence}`
      if (!rects.has(key) || rects.get(key)?.scrollElement !== scrollElement)
        rects.set(key, {
          target,
          scrollElement,
          rect: {
            left: rect.left + scrollX + (scrollElement?.scrollLeft ?? 0),
            right: rect.right + scrollX + (scrollElement?.scrollLeft ?? 0),
            top: rect.top + scrollY + (scrollElement?.scrollTop ?? 0),
            bottom: rect.bottom + scrollY + (scrollElement?.scrollTop ?? 0),
          },
        })
    }
    return Array.from(rects.values(), ({ target, rect, scrollElement }) => {
      const clip = scrollElement?.getBoundingClientRect()
      return {
        target,
        rect: {
          left: Math.max(
            rect.left - scrollX - (scrollElement?.scrollLeft ?? 0),
            clip?.left ?? -Infinity
          ),
          right: Math.min(
            rect.right - scrollX - (scrollElement?.scrollLeft ?? 0),
            clip?.right ?? Infinity
          ),
          top: Math.max(
            rect.top - scrollY - (scrollElement?.scrollTop ?? 0),
            clip?.top ?? -Infinity
          ),
          bottom: Math.min(
            rect.bottom - scrollY - (scrollElement?.scrollTop ?? 0),
            clip?.bottom ?? Infinity
          ),
        },
      }
    })
  }
}

/**
 * Collect visible family and variant drop targets and clip nested targets to their
 * scrollable lists.
 */
export function collectDragTargets(
  root: HTMLElement | null,
  families: DragFamily[]
): TargetRect[] {
  if (!root) return []
  const targets: TargetRect[] = []
  for (const element of root.querySelectorAll<HTMLElement>(
    '[data-drag-family]'
  )) {
    const familyId = element.dataset.dragFamily
    const index = families.findIndex(
      (family) => family.template.id === familyId
    )
    if (index < 0) continue
    const rect = element.getBoundingClientRect()
    if (families[index].template.deleted) {
      targets.push({
        target: { kind: 'merge', familyId: families[index].template.id },
        rect,
      })
      continue
    }
    const edge = (rect.right - rect.left) / 4
    targets.push(
      {
        target: {
          kind: 'family-slot',
          index,
          anchor: { kind: 'before', anchorId: familyId! },
        },
        rect: {
          left: rect.left - 8,
          right: rect.left + edge,
          top: rect.top,
          bottom: rect.bottom,
        },
      },
      {
        target: {
          kind: 'family-slot',
          index: index + 1,
          anchor: { kind: 'after', anchorId: familyId! },
        },
        rect: {
          left: rect.right - edge,
          right: rect.right + 8,
          top: rect.top,
          bottom: rect.bottom,
        },
      },
      {
        target: { kind: 'merge', familyId: familyId! },
        rect: {
          left: rect.left + edge,
          right: rect.right - edge,
          top: rect.top,
          bottom: rect.bottom,
        },
      }
    )
    for (const variant of element.querySelectorAll<HTMLElement>(
      '[data-drag-variant]'
    )) {
      const variantIndex = families[index].variants.findIndex(
        (plate) => plate.id === variant.dataset.dragVariant
      )
      if (variantIndex < 0 || families[index].variants[variantIndex].deleted)
        continue
      const bounds = variant.getBoundingClientRect()
      const scrollElement =
        variant.closest<HTMLElement>('[data-variant-scroll]') ?? undefined
      const midpoint = (bounds.top + bounds.bottom) / 2
      targets.push(
        {
          target: {
            kind: 'variant-slot',
            familyId: familyId!,
            index: variantIndex,
          },
          scrollElement,
          rect: {
            left: bounds.left,
            right: bounds.right,
            top: bounds.top - 6,
            bottom: midpoint,
          },
        },
        {
          target: {
            kind: 'variant-slot',
            familyId: familyId!,
            index: variantIndex + 1,
          },
          scrollElement,
          rect: {
            left: bounds.left,
            right: bounds.right,
            top: midpoint,
            bottom: bounds.bottom + 6,
          },
        }
      )
    }
  }
  return targets
}
