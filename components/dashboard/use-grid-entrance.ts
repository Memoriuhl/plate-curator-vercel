'use client'

import { useLayoutEffect, type RefObject } from 'react'
import { DROP_DURATION, DROP_EASING, entranceDelay } from './grid-feel'

/**
 * Animate newly loaded family rows when the grid identity changes and motion is
 * permitted.
 */
export function useGridEntrance(container: RefObject<HTMLDivElement | null>, ready: boolean, identity: string) {
  useLayoutEffect(() => {
    if (!ready || !container.current) return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const animations: Animation[] = []
    if (!media.matches) {
      const images = Array.from(container.current.querySelectorAll<HTMLElement>('[data-plate-image]'))
        .map(image => ({ image, bounds: image.getBoundingClientRect() }))
        .filter(({ bounds }) => bounds.bottom > 0 && bounds.top < window.innerHeight)
        .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left)
      const lines: typeof images[] = []
      for (const entry of images) {
        const line = lines.at(-1)
        if (line && Math.abs(entry.bounds.top - line[0].bounds.top) <= 8) line.push(entry)
        else lines.push([entry])
      }
      lines.forEach((line, row) => {
        line.sort((a, b) => a.bounds.left - b.bounds.left).forEach(({ image }, column) => {
          if (!image.animate) return
          const delay = entranceDelay(row, column)
          animations.push(image.animate([
            { transform: 'perspective(800px) translateY(-18px) rotateX(72deg)' },
            { transform: 'perspective(800px) translateY(0px) rotateX(0deg)' },
          ], { duration: DROP_DURATION, delay, easing: DROP_EASING, fill: 'backwards' }))
          animations.push(image.animate([
            { opacity: 0, offset: 0 },
            { opacity: 1, offset: 0.35 },
            { opacity: 1, offset: 1 },
          ], { duration: DROP_DURATION, delay, fill: 'backwards' }))
        })
      })
    }
    /** Cancel grid entrance animations when the view changes or unmounts. */
    const cancel = () => animations.forEach(animation => animation.cancel())
    media.addEventListener('change', cancel)
    return () => {
      cancel()
      media.removeEventListener('change', cancel)
    }
  }, [container, ready, identity])
}
