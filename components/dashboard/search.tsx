'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { IoSearchOutline } from 'react-icons/io5'

export function DashboardSearch() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (
        event.key === '/' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !target?.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        event.preventDefault()
        input.current?.focus()
      }
    }
    document.addEventListener('keydown', shortcut)
    return () => document.removeEventListener('keydown', shortcut)
  }, [])
  return (
    <label className="dashboard-search">
      <IoSearchOutline aria-hidden="true" />
      <input
        ref={input}
        type="search"
        aria-label="Search every plate by name, id or tag"
        placeholder="Search every plate by name, id or tag"
        value={params.get('q') ?? ''}
        onChange={(event) => {
          const next = new URLSearchParams(params)
          if (event.target.value) next.set('q', event.target.value)
          else next.delete('q')
          router.replace(`${pathname}${next.size ? `?${next}` : ''}`, {
            scroll: false,
          })
        }}
      />
      <kbd aria-hidden="true">/</kbd>
    </label>
  )
}
