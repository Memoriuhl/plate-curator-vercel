import type { ResearchStateStore } from './state'

export const RESEARCH_LIMITS = { 'web-search': 3, 'web-page': 6, model: 10, 'wiki-search': 2, 'wiki-article': 3 } as const
export type ResearchCall = keyof typeof RESEARCH_LIMITS
export type LimitDeps = { store: ResearchStateStore; now(): number; deadline: number }

/**
 * Reserve one tool call atomically only while the research run is within its deadline
 * and allowance.
 */
export async function reserveResearchCall(jobId: string, kind: ResearchCall, deps: LimitDeps): Promise<'reserved' | 'exhausted'> {
  if (deps.now() >= deps.deadline) return 'exhausted'
  return deps.store.update<Record<string, number>, 'reserved' | 'exhausted'>(`limits/${jobId}`, prior => {
    const value = prior ?? {}
    if (deps.now() >= deps.deadline || (value[kind] ?? 0) >= RESEARCH_LIMITS[kind]) return { value, result: 'exhausted' }
    return { value: { ...value, [kind]: (value[kind] ?? 0) + 1 }, result: 'reserved' }
  })
}
