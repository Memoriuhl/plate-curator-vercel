'use client'

import { useEffect } from 'react'

/** Reveal the scrollbar on the page or overflow region that is currently moving. */
export function ScrollbarActivity() {
  useEffect(() => {
    const timers = new Map<HTMLElement, number>()

    function reveal(event: Event) {
      const element =
        event.target === document ? document.scrollingElement : event.target
      if (!(element instanceof HTMLElement)) return

      const timer = timers.get(element)
      if (timer === undefined) element.setAttribute('data-scrollbar-active', '')
      else window.clearTimeout(timer)

      timers.set(
        element,
        window.setTimeout(() => {
          element.removeAttribute('data-scrollbar-active')
          timers.delete(element)
        }, 700)
      )
    }

    document.addEventListener('scroll', reveal, {
      capture: true,
      passive: true,
    })
    return () => {
      document.removeEventListener('scroll', reveal, true)
      for (const [element, timer] of timers) {
        window.clearTimeout(timer)
        element.removeAttribute('data-scrollbar-active')
      }
    }
  }, [])

  return null
}
