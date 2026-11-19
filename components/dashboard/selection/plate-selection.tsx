'use client'

import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type MouseEvent,
  type HTMLAttributes,
} from 'react'
import { groupFamilies } from '../family-grid/family-data'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'

/** Create the shared selection store for multi-plate actions across visible states. */
export function createPlateSelection() {
  let selected: readonly PlateCardData[] = []
  let ids = new Set<string>()
  let anchor: string | null = null
  let visible: PlateCardData[] = []
  let visibleIds = new Set<string>()
  let loaded: PlateCardData[] = []
  let loadedIds = new Set<string>()
  let hiddenCount = 0
  const states = new Map<string, PlateCardData[]>()
  let templatesWithVariants = new Set<string>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  const countHidden = () =>
    selected.filter(
      (plate) => loadedIds.has(plate.id) && !visibleIds.has(plate.id)
    ).length
  /** Normalize the next selection, update its ID index and notify subscribers. */
  const publish = (next: readonly PlateCardData[]) => {
    selected = next.filter((plate) => !plate.deleted)
    ids = new Set(selected.map((plate) => plate.id))
    hiddenCount = countHidden()
    notify()
  }
  return {
    /** Register a listener and return the cleanup used by React's external store. */
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /**
     * Expose the current selection snapshot without allocating a new array per render.
     */
    snapshot: () => selected,
    hiddenCount: () => hiddenCount,
    /** Check whether the plate ID is currently selected. */
    has: (id: string) => ids.has(id),
    /** Expose the most recently registered plates to workspace selection actions. */
    loaded: () => loaded,
    /** Check whether the selected template has variants that may move with it. */
    hasVariants: (id: string) => templatesWithVariants.has(id),
    /**
     * Read the registered plates for one state, including those outside the current
     * filter.
     */
    statePlates: (state: string) => states.get(state) ?? [],
    /** Replace the selection. */
    replace(plates: readonly PlateCardData[]) {
      publish(plates)
    },
    /**
     * Index loaded plates and reconcile selected records when their latest versions
     * arrive.
     */
    register(plates: PlateCardData[]) {
      if (loaded === plates) return
      loaded = plates
      loadedIds = new Set(plates.map((plate) => plate.id))
      for (const [state, group] of Map.groupBy(plates, (plate) => plate.state))
        states.set(state, group)
      templatesWithVariants = new Set(
        [...states.values()]
          .flatMap(groupFamilies)
          .filter((family) => family.variants.length)
          .map((family) => family.template.id)
      )
      const fresh = new Map(plates.map((plate) => [plate.id, plate]))
      const next = selected.map((plate) => fresh.get(plate.id) ?? plate)
      if (
        next.some((plate, index) => plate.deleted || plate !== selected[index])
      )
        publish(next)
    },
    /**
     * Update the range used for keyboard and shift selection and count the
     * selected plates hidden by the current filter.
     */
    visible(plates: PlateCardData[]) {
      visible = plates.filter((plate) => !plate.deleted)
      visibleIds = new Set(visible.map((plate) => plate.id))
      const next = countHidden()
      if (next === hiddenCount) return
      hiddenCount = next
      notify()
    },
    /** Clear the selected plates and reset the range anchor. */
    clear() {
      anchor = null
      publish([])
    },
    /** Add plates to the selection without duplicating plate IDs. */
    add(plates: PlateCardData[]) {
      publish([
        ...new Map(
          [...selected, ...plates].map((plate) => [plate.id, plate])
        ).values(),
      ])
    },
    /**
     * Select the registered plates for a whole state while retaining selections from
     * other states.
     */
    selectState(state: string) {
      const plates = states.get(state)
      if (!plates?.length) return
      publish([
        ...new Map(
          [...selected, ...plates].map((plate) => [plate.id, plate])
        ).values(),
      ])
    },
    /** Select only matching plates in this view and retain selections in other states. */
    all() {
      const currentStates = new Set(
        (loaded.length ? loaded : visible).map((plate) => plate.state)
      )
      publish([
        ...selected.filter((plate) => !currentStates.has(plate.state)),
        ...visible,
      ])
    },
    /**
     * Select, toggle or range-select a visible plate according to the current modifier
     * keys.
     */
    select(
      id: string,
      modifiers: {
        shiftKey?: boolean
        ctrlKey?: boolean
        metaKey?: boolean
      } = {}
    ) {
      const plate = visible.find((plate) => plate.id === id)
      if (!plate) return
      const a = visible.findIndex((plate) => plate.id === anchor)
      const b = visible.indexOf(plate)
      const otherStates = selected.filter(
        (selectedPlate) => selectedPlate.state !== plate.state
      )
      if (modifiers.shiftKey && a >= 0) {
        publish([
          ...otherStates,
          ...visible.slice(Math.min(a, b), Math.max(a, b) + 1),
        ])
        return
      }
      const exists = selected.some((plate) => plate.id === id)
      publish(
        exists
          ? selected.filter((plate) => plate.id !== id)
          : modifiers.ctrlKey || modifiers.metaKey
            ? [...selected, plate]
            : [...otherStates, plate]
      )
      anchor = exists && !modifiers.ctrlKey && !modifiers.metaKey ? null : id
    },
  }
}

export const plateSelection = createPlateSelection()
const empty: readonly PlateCardData[] = []
/** Subscribe a component to the shared list of selected plates. */
export function useSelectedPlates() {
  return useSyncExternalStore(
    plateSelection.subscribe,
    plateSelection.snapshot,
    () => empty
  )
}
/** Subscribe to the count of selected plates hidden by the current filter. */
export function useHiddenSelectionCount() {
  return useSyncExternalStore(
    plateSelection.subscribe,
    plateSelection.hiddenCount,
    () => 0
  )
}
/** Subscribe to whether a jurisdiction contains any selected plates. */
export function useStateSelected(code: string) {
  return useSyncExternalStore(
    plateSelection.subscribe,
    () => plateSelection.snapshot().some((plate) => plate.state === code),
    () => false
  )
}
/** Subscribe to whether the given plate is selected. */
export function usePlateSelected(id: string) {
  return useSyncExternalStore(
    plateSelection.subscribe,
    () => plateSelection.has(id),
    () => false
  )
}
/** Recognize interactive controls that should handle their own selection shortcuts. */
export function selectionInput(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"], [data-radix-popper-content-wrapper]'
    )
  )
}
/**
 * Wrap a plate row with selection behavior and an accessible selected-state description.
 */
export function SelectionPlate({
  id,
  children,
  disabled = false,
  highlight = true,
  className = '',
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, 'id'> & {
  id: string
  disabled?: boolean
  highlight?: boolean
}) {
  const selected = usePlateSelected(id)
  const statusId = useId()
  /**
   * Handle a plate's selection click while respecting nested controls and link
   * interactions.
   */
  function select(event: MouseEvent) {
    const target = event.target as Element
    if (target.closest('button, input')) return
    if (
      target.closest('a') &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    )
      return
    event.preventDefault()
    event.stopPropagation()
    if (!disabled) plateSelection.select(id, event)
  }
  return (
    <div
      {...props}
      tabIndex={0}
      data-selected={selected}
      aria-describedby={statusId}
      aria-disabled={disabled}
      onClickCapture={select}
      className={
        'relative select-none rounded-[var(--radius-sm)] transition-shadow focus-visible:outline-2 focus-visible:outline-[var(--primary)] ' +
        (selected && highlight
          ? 'bg-[color-mix(in_srgb,var(--primary)_12%,var(--card))] ring-2 ring-[var(--primary)] '
          : 'hover:ring-1 hover:ring-[var(--hairline)] ') +
        className
      }
    >
      {children}
      <span id={statusId} className="sr-only">
        {selected ? 'Selected' : 'Not selected'}
      </span>
    </div>
  )
}

const runPipelineSelector = '[data-run-menu], [data-run-trigger]'
function runPipelineInteraction(event: Event) {
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof Element && target.matches(runPipelineSelector)
    )
}

/**
 * Bind workspace keyboard shortcuts to the latest selection, preview and promotion
 * actions.
 */
export function useSelectionKeyboard({
  close,
  promote,
  disabled,
  dragging = false,
}: {
  close(): void
  promote(): Promise<void>
  disabled: boolean
  dragging?: boolean
}) {
  const latest = useRef({ close, promote, disabled, dragging })
  useEffect(() => {
    latest.current = { close, promote, disabled, dragging }
  })
  useEffect(() => {
    /**
     * Handle bulk selection shortcuts only when a focused control is not using the key.
     */
    function key(event: KeyboardEvent) {
      if (
        runPipelineInteraction(event) ||
        document.activeElement?.closest(runPipelineSelector) ||
        selectionInput(event.target) ||
        selectionInput(document.activeElement) ||
        event.defaultPrevented ||
        latest.current.dragging
      )
        return
      if (event.key === 'Escape') {
        latest.current.close()
        plateSelection.clear()
      }
      if (
        ['Backspace', 'Delete'].includes(event.key) &&
        plateSelection.snapshot().length
      ) {
        event.preventDefault()
        if (!latest.current.disabled) void latest.current.promote()
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        plateSelection.all()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
}

/**
 * Track document selection presence and dismiss it when the user clicks outside its
 * surfaces.
 */
export function SelectionPresence() {
  useEffect(() => {
    /**
     * Clear selection on an unmodified primary click outside the grid or selection
     * controls.
     */
    function dismiss(event: globalThis.MouseEvent) {
      if (
        runPipelineInteraction(event) ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.defaultPrevented ||
        !plateSelection.snapshot().length
      )
        return
      const target = event.target
      if (
        target instanceof Element &&
        target.closest(
          'a, button, input, textarea, select, label, nav, [role="button"], [role="tab"], [role="option"], [data-selection-controls], [role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], #plate-breakdown-preview'
        )
      )
        return
      plateSelection.clear()
    }
    window.addEventListener('click', dismiss)
    return () => window.removeEventListener('click', dismiss)
  }, [])
  const any = useSyncExternalStore(
    plateSelection.subscribe,
    () => plateSelection.snapshot().length > 0,
    () => false
  )
  useEffect(() => {
    document.documentElement.dataset.hasSelection = String(any)
    return () => {
      delete document.documentElement.dataset.hasSelection
    }
  }, [any])
  return null
}

/** Highlight a family when its template appears in the active selection. */
export function SelectionFamily({
  id,
  className = '',
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'id'> & { id: string }) {
  const selected = usePlateSelected(id)
  return (
    <article
      {...props}
      data-selected={selected}
      className={className + (selected ? ' ring-2 ring-[var(--primary)]' : '')}
    />
  )
}
