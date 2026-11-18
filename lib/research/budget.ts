import type { ResearchStateStore } from './state'

type Entry = { modelReservedMicros: number; searchMicros: number; modelActualMicros?: number }
type Budget = { limitMicros: number; committedMicros: number; runs: Record<string, Entry> }
/**
 * Round costs up to integer microdollars so reservations use a consistent accounting
 * unit.
 */
const micros = (usd: number) => Math.ceil(usd * 1000000)

/**
 * Reserve model spend atomically against the active research budget before making a
 * request.
 */
export async function reserveResearchSpend(store: ResearchStateStore, campaign: string, runId: string, kind: 'model' | 'search', usd: number, limitUsd: number) {
  if (!Number.isFinite(usd) || usd <= 0 || !Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > 2) throw new Error('Invalid research budget reservation')
  const amount = micros(usd)
  return store.update<Budget, boolean>(`budget/${campaign}`, prior => {
    const value = prior ?? { limitMicros: micros(limitUsd), committedMicros: 0, runs: {} }
    const entry = value.runs[runId] ?? { modelReservedMicros: 0, searchMicros: 0 }
    if (entry.modelActualMicros !== undefined || value.committedMicros + amount > Math.min(value.limitMicros, micros(limitUsd))) return { value, result: false }
    return { value: { ...value, committedMicros: value.committedMicros + amount, runs: { ...value.runs, [runId]: { ...entry, [kind === 'model' ? 'modelReservedMicros' : 'searchMicros']: (kind === 'model' ? entry.modelReservedMicros : entry.searchMicros) + amount } } }, result: true }
  })
}

/** Replace a reserved amount with reported actual cost when the provider supplies it. */
export async function settleResearchModelSpend(store: ResearchStateStore, campaign: string, runId: string, actualUsd: number | undefined) {
  if (actualUsd === undefined) return
  if (!Number.isFinite(actualUsd) || actualUsd < 0) throw new Error('Invalid reported model charge')
  await store.update<Budget, null>(`budget/${campaign}`, prior => {
    const value = prior ?? { limitMicros: 2000000, committedMicros: 0, runs: {} }
    const entry = value.runs[runId]
    if (!entry) return { value, result: null }
    const actual = micros(actualUsd)
    return { value: { ...value, committedMicros: value.committedMicros - (entry.modelActualMicros ?? entry.modelReservedMicros) + actual, runs: { ...value.runs, [runId]: { ...entry, modelActualMicros: actual } } }, result: null }
  })
}
