'use client'

import { useEffect, useRef, type CSSProperties } from 'react'

export function ScrollingPlateId({ id }: { id: string }) {
  const line = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    const element = line.current
    if (!element) return
    const measure = () => {
      const overflow = Math.max(0, element.scrollWidth - element.clientWidth)
      element.style.setProperty('--id-offset', `-${overflow}px`)
      element.style.setProperty('--id-duration', `${Math.max(600, overflow / 40 * 1000)}ms`)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [id])
  return (
    <p ref={line} title={id} className="group/id id min-w-0 overflow-hidden whitespace-nowrap font-mono text-[var(--ink-2)]" style={{ '--id-offset': '0px', '--id-duration': '600ms' } as CSSProperties}>
      <span className="inline-block transition-transform duration-[var(--id-duration)] ease-in-out group-hover/id:translate-x-[var(--id-offset)] group-focus/plate:translate-x-[var(--id-offset)] motion-reduce:transition-none">{id}</span>
    </p>
  )
}
