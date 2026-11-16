'use client'

import { useLayoutEffect, type RefObject } from 'react'
import { DROP_DURATION, DROP_EASING, entranceDelay } from './grid-feel'

export function useGridEntrance(container: RefObject<HTMLDivElement | null>, ready: boolean, identity: string) {
  useLayoutEffect(() => {
    if (!ready || !container.current) return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const animations: Animation[] = []
    if (!media.matches) {
      for (const row of container.current.children) {
        const bounds = row.getBoundingClientRect()
        if (bounds.bottom <= 0 || bounds.top >= window.innerHeight) continue
        Array.from(row.children).forEach((card, column) => {
          if (!(card instanceof HTMLElement) || !card.animate) return
          const delay = entranceDelay(Number(row.getAttribute('data-index')), column)
          animations.push(card.animate([
            { transform: 'perspective(800px) translateY(-18px) rotateX(72deg)' },
            { transform: 'perspective(800px) translateY(0px) rotateX(0deg)' },
          ], { duration: DROP_DURATION, delay, easing: DROP_EASING, fill: 'backwards' }))
          animations.push(card.animate([
            { opacity: 0, offset: 0 },
            { opacity: 1, offset: 0.35 },
            { opacity: 1, offset: 1 },
          ], { duration: DROP_DURATION, delay, fill: 'backwards' }))
        })
      }
    }
    const cancel = () => animations.forEach(animation => animation.cancel())
    media.addEventListener('change', cancel)
    return () => {
      cancel()
      media.removeEventListener('change', cancel)
    }
  }, [container, ready, identity])
}
