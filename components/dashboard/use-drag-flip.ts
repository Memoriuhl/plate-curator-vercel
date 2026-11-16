'use client'

import { useLayoutEffect, useRef, type RefObject } from 'react'

type Position = { left: number; top: number }
type Motion = { animation: Animation; dx: number; dy: number }
export type FlipSnapshot = Map<string, Position>

export function measureDragPositions(root: HTMLElement): FlipSnapshot {
  return new Map(Array.from(root.querySelectorAll<HTMLElement>('[data-reflow-key]'), element => {
    const rect = element.getBoundingClientRect()
    return [element.dataset.reflowKey!, { left: rect.left + window.scrollX, top: rect.top + window.scrollY }]
  }))
}

export function playDragFlip(root: HTMLElement, previous: FlipSnapshot, reducedMotion: boolean, motions = new Map<string, Motion>()) {
  const offsets = new Map<string, Position>()
  for (const [key, motion] of motions) {
    const progress = motion.animation.effect?.getComputedTiming().progress ?? 1
    offsets.set(key, { left: motion.dx * (1 - progress), top: motion.dy * (1 - progress) })
    motion.animation.cancel()
  }
  motions.clear()
  const next = measureDragPositions(root)
  const elements = Array.from(root.querySelectorAll<HTMLElement>('[data-reflow-key]'))
  const changes = new Map<string, Position>()
  for (const [key, rect] of next) {
    const before = previous.get(key)
    if (before) changes.set(key, { left: before.left - rect.left + (offsets.get(key)?.left ?? 0), top: before.top - rect.top + (offsets.get(key)?.top ?? 0) })
  }
  if (!reducedMotion) for (const element of elements) {
    const key = element.dataset.reflowKey!
    const delta = changes.get(key)
    if (!delta || !element.animate) continue
    const parent = element.parentElement?.closest<HTMLElement>('[data-reflow-key]')
    const parentDelta = parent && changes.get(parent.dataset.reflowKey!)
    const dx = delta.left - (parentDelta?.left ?? 0)
    const dy = delta.top - (parentDelta?.top ?? 0)
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
    const animation = element.animate([
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: 'translate(0px, 0px)' },
    ], { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' })
    motions.set(key, { animation, dx, dy })
  }
  return next
}

export function useDragFlip(container: RefObject<HTMLElement | null>, identity: unknown, enabled: boolean) {
  const positions = useRef<FlipSnapshot>(new Map())
  const motions = useRef(new Map<string, Motion>())
  useLayoutEffect(() => {
    const root = container.current
    if (!root) return
    positions.current = playDragFlip(root, positions.current, !enabled || window.matchMedia('(prefers-reduced-motion: reduce)').matches, motions.current)
  }, [container, identity, enabled])
  useLayoutEffect(() => {
    const running = motions.current
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const cancel = () => { running.forEach(motion => motion.animation.cancel()); running.clear() }
    media.addEventListener('change', cancel)
    return () => { cancel(); media.removeEventListener('change', cancel) }
  }, [])
}
