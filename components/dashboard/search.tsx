'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { IoSearchOutline } from 'react-icons/io5'

export function DashboardSearch() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const input = useRef<HTMLInputElement>(null)
  const query = params.get('q') ?? ''
  const queryString = params.toString()
  const [search, setSearch] = useState(() => ({ value: query, query, pending: [] as string[] }))
  const value = search.value
  if (search.query !== query) {
    setSearch(current => {
      const acknowledgement = current.pending.indexOf(query)
      return {
        value: acknowledgement < 0 ? query : current.value,
        query,
        pending: current.pending.filter((_, index) => index !== acknowledgement),
      }
    })
  }
  useEffect(() => {
    if (value === query) return
    const timer = setTimeout(() => {
      const next = new URLSearchParams(queryString)
      if (value) next.set('q', value)
      else next.delete('q')
      setSearch(current => ({ ...current, pending: [...current.pending, value] }))
      router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false })
    }, 250)
    return () => clearTimeout(timer)
  }, [value, query, queryString, pathname, router])
  useEffect(() => {
    function historyChange() {
      const value = new URLSearchParams(window.location.search).get('q') ?? ''
      setSearch(current => ({ ...current, value }))
    }
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
    window.addEventListener('popstate', historyChange)
    return () => {
      document.removeEventListener('keydown', shortcut)
      window.removeEventListener('popstate', historyChange)
    }
  }, [])
  return (
    <label className="dashboard-search">
      <IoSearchOutline aria-hidden="true" />
      <input
        ref={input}
        type="search"
        aria-label="Search every plate by name, id or tag"
        placeholder="Search every plate by name, id or tag"
        value={search.value}
        onChange={event => {
          const value = event.target.value
          setSearch(current => ({ ...current, value }))
        }}
      />
      <kbd aria-hidden="true">/</kbd>
    </label>
  )
}
