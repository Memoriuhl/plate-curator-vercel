'use client'

import { useEffect, useRef, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'

export function createPlateSelection() {
  let selected: readonly PlateCardData[] = []
  let ids = new Set<string>()
  let anchor: string | null = null
  let visible: PlateCardData[] = []
  let loaded: PlateCardData[] = []
  const listeners = new Set<() => void>()
  const publish = (next: readonly PlateCardData[]) => { selected = next; ids = new Set(next.map(plate => plate.id)); listeners.forEach(listener => listener()) }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot: () => selected,
    has: (id: string) => ids.has(id),
    loaded: () => loaded,
    register(plates: PlateCardData[]) {
      if (loaded === plates) return
      loaded = plates
      const fresh = new Map(plates.map(plate => [plate.id, plate]))
      const next = selected.map(plate => fresh.get(plate.id) ?? plate)
      if (next.some((plate, index) => plate !== selected[index])) publish(next)
    },
    visible(plates: PlateCardData[]) { visible = plates },
    clear() { anchor = null; publish([]) },
    add(plates: PlateCardData[]) { publish([...new Map([...selected, ...plates].map(plate => [plate.id, plate])).values()]) },
    all() { publish(visible) },
    select(id: string, modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}) {
      const plate = visible.find(plate => plate.id === id)
      if (!plate) return
      const a = visible.findIndex(plate => plate.id === anchor)
      const b = visible.indexOf(plate)
      if (modifiers.shiftKey && a >= 0) { publish(visible.slice(Math.min(a, b), Math.max(a, b) + 1)); return }
      const exists = selected.some(plate => plate.id === id)
      publish(exists ? selected.filter(plate => plate.id !== id) : modifiers.ctrlKey || modifiers.metaKey ? [...selected, plate] : [plate])
      anchor = exists && !modifiers.ctrlKey && !modifiers.metaKey ? null : id
    },
  }
}

export const plateSelection = createPlateSelection()
const empty: readonly PlateCardData[] = []
export function useSelectedPlates() { return useSyncExternalStore(plateSelection.subscribe, plateSelection.snapshot, () => empty) }
export function useStateSelected(code: string) { return useSyncExternalStore(plateSelection.subscribe, () => plateSelection.snapshot().some(plate => plate.state === code), () => false) }
export function usePlateSelected(id: string) { return useSyncExternalStore(plateSelection.subscribe, () => plateSelection.has(id), () => false) }
export function selectionInput(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
}
export function SelectionPlate({ id, children }: { id: string; children: ReactNode }) {
  const selected = usePlateSelected(id)
  function select(event: MouseEvent) {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    plateSelection.select(id, event)
  }
  return <div onClickCapture={select} className={selected ? 'rounded-[var(--radius-sm)] ring-2 ring-[var(--primary)]' : undefined}>
    <button type="button" aria-label={'Select ' + id} aria-pressed={selected} className="caption rounded-sm px-1 focus-visible:outline-2 focus-visible:outline-[var(--primary)]" onClick={event => plateSelection.select(id, event)}>{selected ? 'Selected' : 'Select'}</button>
    {children}
  </div>
}

export function useSelectionKeyboard({ close, promote, disabled }: { close(): void; promote(): Promise<void>; disabled: boolean }) {
  const latest = useRef({ close, promote, disabled })
  useEffect(() => { latest.current = { close, promote, disabled } })
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') { latest.current.close(); plateSelection.clear() }
      if (selectionInput(event.target) || event.defaultPrevented) return
      if (['Backspace', 'Delete'].includes(event.key) && plateSelection.snapshot().length) {
        event.preventDefault()
        if (!latest.current.disabled) void latest.current.promote()
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); plateSelection.all() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
}
