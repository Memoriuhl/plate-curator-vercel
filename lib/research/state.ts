export interface ResearchStateStore {
  read<T>(key: string): Promise<T | null>
  update<T, R>(
    key: string,
    change: (value: T | null) => { value: T; result: R }
  ): Promise<R>
}

/** Create a serial, in-memory research state adapter for tests and temporary runs. */
export function createResearchMemoryState(): ResearchStateStore {
  const values = new Map<string, unknown>()
  let pending = Promise.resolve()
  return {
    /** Wait for pending updates and return a copy of the committed value. */
    async read<T>(key: string) {
      await pending
      return structuredClone(values.get(key) ?? null) as T | null
    },
    /**
     * Apply one state update at a time so concurrent tools cannot overwrite each other's
     * changes.
     */
    async update<T, R>(
      key: string,
      change: (value: T | null) => { value: T; result: R }
    ) {
      let release!: () => void
      const previous = pending
      pending = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      try {
        const changed = change(
          structuredClone(values.get(key) ?? null) as T | null
        )
        values.set(key, structuredClone(changed.value))
        return changed.result
      } finally {
        release()
      }
    },
  }
}
