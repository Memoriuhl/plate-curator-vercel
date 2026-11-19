import { useSyncExternalStore } from 'react'

/** An action the selection bar can start on behalf of the component that owns it. */
export type SelectionAction = { run(): void | Promise<void>; disabled: boolean }

/**
 * Create a small registry that lets the selection bar trigger actions owned by other
 * components (the family grid's promote and the run menu) without importing them.
 */
export function createSelectionActions() {
  const actions = new Map<'promote' | 'runPipeline', SelectionAction>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get: (name: 'promote' | 'runPipeline') => actions.get(name),
    /** Register an action and return the cleanup that removes it again. */
    register(name: 'promote' | 'runPipeline', action: SelectionAction) {
      actions.set(name, action)
      notify()
      return () => {
        if (actions.get(name) !== action) return
        actions.delete(name)
        notify()
      }
    },
  }
}

export const selectionActions = createSelectionActions()

/** Subscribe to one registered action; undefined while its owner is not mounted. */
export function useSelectionAction(name: 'promote' | 'runPipeline') {
  return useSyncExternalStore(
    selectionActions.subscribe,
    () => selectionActions.get(name),
    () => undefined
  )
}
