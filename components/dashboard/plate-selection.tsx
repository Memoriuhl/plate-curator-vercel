'use client'

import { useEffect, useRef, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'

export function createPlateSelection() {
  let selected: readonly PlateCardData[] = []
  let ids = new Set<string>()
  let anchor: string | null = null
  let visible: PlateCardData[] = []
  let loaded: PlateCardData[] = []
  const states = new Map<string, PlateCardData[]>()
  const listeners = new Set<() => void>()
  const publish = (next: readonly PlateCardData[]) => { selected = next.filter(plate => !plate.deleted); ids = new Set(selected.map(plate => plate.id)); listeners.forEach(listener => listener()) }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot: () => selected,
    has: (id: string) => ids.has(id),
    loaded: () => loaded,
    statePlates: (state: string) => states.get(state) ?? [],
    replace(plates: readonly PlateCardData[]) { publish(plates) },
    register(plates: PlateCardData[]) {
      if (loaded === plates) return
      loaded = plates
      for (const [state, group] of Map.groupBy(plates, plate => plate.state)) states.set(state, group)
      const fresh = new Map(plates.map(plate => [plate.id, plate]))
      const next = selected.map(plate => fresh.get(plate.id) ?? plate)
      if (next.some((plate, index) => plate.deleted || plate !== selected[index])) publish(next)
    },
    visible(plates: PlateCardData[]) {
      visible = plates.filter(plate => !plate.deleted)
      const loadedIds = new Set(loaded.map(plate => plate.id))
      const visibleIds = new Set(plates.map(plate => plate.id))
      const next = selected.filter(plate => !loadedIds.has(plate.id) || visibleIds.has(plate.id))
      if (next.length !== selected.length) publish(next)
    },
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
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"], [data-radix-popper-content-wrapper]')
}
export function SelectionPlate({ id, children, disabled = false }: { id: string; children: ReactNode; disabled?: boolean }) {
  const selected = usePlateSelected(id)
  function select(event: MouseEvent) {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    if (!disabled) plateSelection.select(id, event)
  }
  return <div onClickCapture={select} className={'group/selection relative ' + (selected ? 'rounded-[var(--radius-sm)] ring-2 ring-[var(--primary)]' : '')}>
    {children}
  </div>
}

export function SelectionCheckbox({ id, disabled = false, imageOffset = 0 }: { id: string; disabled?: boolean; imageOffset?: number }) {
  const selected = usePlateSelected(id)
  return <input type="checkbox" aria-label={'Select ' + id} checked={selected} disabled={disabled}
    title={disabled ? 'Does not match the current filters' : 'Select plate'}
    data-plate-selection style={{ left: imageOffset + 4 }}
    className="absolute top-1 left-1 z-10 size-4 accent-[var(--primary)] opacity-0 group-hover/selection:opacity-100 group-focus-within/selection:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 in-data-[has-selection=true]:opacity-100"
    onPointerDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); plateSelection.select(id, { ctrlKey: true }) }}
    onChange={() => {}} />
}

export function useSelectionKeyboard({ close, promote, disabled, dragging = false }: { close(): void; promote(): Promise<void>; disabled: boolean; dragging?: boolean }) {
  const latest = useRef({ close, promote, disabled, dragging })
  useEffect(() => { latest.current = { close, promote, disabled, dragging } })
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (selectionInput(event.target) || selectionInput(document.activeElement) || event.defaultPrevented || latest.current.dragging) return
      if (event.key === 'Escape') { latest.current.close(); plateSelection.clear() }
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

export function SelectionPresence() {
  const any = useSyncExternalStore(plateSelection.subscribe, () => plateSelection.snapshot().length > 0, () => false)
  useEffect(() => {
    document.documentElement.dataset.hasSelection = String(any)
    return () => { delete document.documentElement.dataset.hasSelection }
  }, [any])
  return null
}
