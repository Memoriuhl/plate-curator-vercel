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
  const href = `${pathname}${queryString ? `?${queryString}` : ''}`
  const [search, setSearch] = useState(() => ({ value: query, query, href, pathname, queryString, pending: [] as string[] }))
  const value = search.value
  if (search.href !== href) {
    setSearch(current => {
      const acknowledgement = current.pending.indexOf(href)
      return {
        value: acknowledgement < 0 && current.query !== query ? query : current.value,
        query,
        href,
        pathname: acknowledgement < 0 ? pathname : current.pathname,
        queryString: acknowledgement < 0 ? queryString : current.queryString,
        pending: current.pending.filter((_, index) => index !== acknowledgement),
      }
    })
  }
  const next = new URLSearchParams(search.queryString)
  if (value) next.set('q', value)
  else next.delete('q')
  const targetHref = `${search.pathname}${next.size ? `?${next}` : ''}`
  useEffect(() => {
    if (targetHref === href) return
    const timer = setTimeout(() => {
      setSearch(current => ({ ...current, pending: [...current.pending, targetHref] }))
      router.replace(targetHref, { scroll: false })
    }, 250)
    return () => clearTimeout(timer)
  }, [targetHref, href, router])
  useEffect(() => {
    function historyChange() {
      const params = new URLSearchParams(window.location.search)
      setSearch(current => ({ ...current, value: params.get('q') ?? '', pathname: window.location.pathname, queryString: params.toString() }))
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
