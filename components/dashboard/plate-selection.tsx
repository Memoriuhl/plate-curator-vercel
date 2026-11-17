'use client'

import { useEffect, useId, useRef, useSyncExternalStore, type MouseEvent, type HTMLAttributes } from 'react'
import { Button } from '@/components/ui/button'
import { groupFamilies } from './family-data'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'

export function createPlateSelection() {
  let selected: readonly PlateCardData[] = []
  let ids = new Set<string>()
  let anchor: string | null = null
  let visible: PlateCardData[] = []
  let loaded: PlateCardData[] = []
  const states = new Map<string, PlateCardData[]>()
  let templatesWithVariants = new Set<string>()
  const listeners = new Set<() => void>()
  const publish = (next: readonly PlateCardData[]) => { selected = next.filter(plate => !plate.deleted); ids = new Set(selected.map(plate => plate.id)); listeners.forEach(listener => listener()) }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot: () => selected,
    has: (id: string) => ids.has(id),
    loaded: () => loaded,
    hasVariants: (id: string) => templatesWithVariants.has(id),
    statePlates: (state: string) => states.get(state) ?? [],
    replace(plates: readonly PlateCardData[]) { publish(plates) },
    register(plates: PlateCardData[]) {
      if (loaded === plates) return
      loaded = plates
      for (const [state, group] of Map.groupBy(plates, plate => plate.state)) states.set(state, group)
      templatesWithVariants = new Set([...states.values()].flatMap(groupFamilies).filter(family => family.variants.length).map(family => family.template.id))
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
export function SelectionPlate({ id, children, disabled = false, highlight = true, className = '', ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'id'> & { id: string; disabled?: boolean; highlight?: boolean }) {
  const selected = usePlateSelected(id)
  const statusId = useId()
  function select(event: MouseEvent) {
    const target = event.target as Element
    if (target.closest('button, input, [data-plate-open]')) return
    if (target.closest('a') && !event.ctrlKey && !event.metaKey && !event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    if (!disabled) plateSelection.select(id, event)
  }
  return <div {...props} tabIndex={0} data-selected={selected} aria-describedby={statusId} aria-disabled={disabled} onClickCapture={select}
    className={'relative select-none rounded-[var(--radius-sm)] transition-shadow focus-visible:outline-2 focus-visible:outline-[var(--primary)] ' + (selected && highlight ? 'bg-[color-mix(in_srgb,var(--primary)_12%,var(--card))] ring-2 ring-[var(--primary)] ' : 'hover:ring-1 hover:ring-[var(--hairline)] ') + className}>
    {children}
    <span id={statusId} className="sr-only">{selected ? 'Selected' : 'Not selected'}</span>
  </div>
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

export function SelectionFamily({ id, className = '', ...props }: Omit<HTMLAttributes<HTMLElement>, 'id'> & { id: string }) {
  const selected = usePlateSelected(id)
  return <article {...props} data-selected={selected} className={className + (selected ? ' ring-2 ring-[var(--primary)]' : '')} />
}

export function MoveSelectionHere({ template, variants, disabled, onMove }: { template: PlateCardData; variants: PlateCardData[]; disabled: boolean; onMove(destination: PlateCardData): Promise<void> }) {
  const count = useSyncExternalStore(plateSelection.subscribe, () => {
    if (template.deleted || !plateSelection.snapshot().length) return 0
    if (plateSelection.has(template.id) && variants.every(plate => plateSelection.has(plate.id))) return 0
    return plateSelection.snapshot().filter(plate => !plate.deleted && plate.state === template.state && plate.id !== template.id && plate.variantOfPlateId !== template.id && !variants.some(variant => variant.id === plate.id) && !plateSelection.hasVariants(plate.id)).length
  }, () => 0)
  if (!count) return null
  return <Button type="button" size="sm" variant="outline" disabled={disabled}
    className="absolute -top-7 right-2 z-10 h-6 bg-[var(--card)] px-2.5 text-xs shadow-md"
    onPointerDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); void onMove(template) }}
  >Move {count} here</Button>
}
