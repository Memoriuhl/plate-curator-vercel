'use client'

import { useState } from 'react'
import { IoDesktopOutline, IoSunnyOutline, IoMoonOutline } from 'react-icons/io5'
import { cn } from '@/components/utils'
import { DropdownMenuItem, DropdownMenuRadioGroup } from '../ui/dropdown-menu'

type Theme = 'system' | 'light' | 'dark'
const options = [
  { value: 'system', label: 'System', Icon: IoDesktopOutline },
  { value: 'light', label: 'Light', Icon: IoSunnyOutline },
  { value: 'dark', label: 'Dark', Icon: IoMoonOutline },
] as const

export function applyTheme(theme: Theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.removeProperty('color-scheme')
  } else {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }
  try {
    localStorage.setItem('plate-curator-theme', theme)
  } catch {}
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof document === 'undefined') return 'system'
    const value = document.documentElement.dataset.theme
    return value === 'light' || value === 'dark' ? value : 'system'
  })
  function choose(value: Theme) {
    applyTheme(value)
    setTheme(value)
  }
  return (
    <DropdownMenuRadioGroup
      role="radiogroup"
      aria-label="Appearance"
      className="mx-auto my-2 flex w-fit gap-1 rounded-xl bg-[var(--fill)] p-1"
    >
      {options.map(({ value, label, Icon }, index) => (
        <DropdownMenuItem
          key={value}
          role="radio"
          aria-checked={theme === value}
          onSelect={(event) => { event.preventDefault(); choose(value) }}
          onKeyDown={(event) => {
            const offset = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
            if (!offset && event.key !== 'Home' && event.key !== 'End') return
            event.preventDefault()
            event.stopPropagation()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + offset + options.length) % options.length
            choose(options[next].value)
            const items = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')
            items?.[next].focus()
          }}
          className={cn('flex min-w-16 flex-col gap-1 px-2 py-2 text-xs focus-visible:outline-2 focus-visible:outline-[var(--ink)]', theme === value && 'bg-[var(--card)] text-[var(--ink)] shadow-sm')}
        >
          <Icon className="size-4" aria-hidden="true" />
          {label}
        </DropdownMenuItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}
