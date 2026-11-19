import type { ResearchStateStore } from './state'
import { RESEARCH_LIMITS } from './limits'
import {
  researchCallReservation,
  reserveResearchSpend,
  settleResearchModelSpend,
} from './budget'
import type { ModelPrice } from '../models/catalog'

export const researchBudgetError = 'Research campaign budget exhausted'

type Attempt = { id: string; costUsd?: number }
/** Register a model attempt and reserve spend before the provider call starts. */
export async function createResearchModelAttempt(
  store: ResearchStateStore,
  runId: string,
  options: {
    campaign: string
    limitUsd: number
    deadline: number
    maxCalls?: number
    price: ModelPrice
    fallbackPrice?: ModelPrice
  }
) {
  const sequence = await store.update<Record<string, number>, number | null>(
    `limits/${runId}`,
    (prior) => {
      const value = prior ?? {}
      if (
        Date.now() >= options.deadline ||
        (value.model ?? 0) >= (options.maxCalls ?? RESEARCH_LIMITS.model)
      )
        return { value, result: null }
      return {
        value: { ...value, model: (value.model ?? 0) + 1 },
        result: (value.model ?? 0) + 1,
      }
    }
  )
  if (sequence === null) throw new Error('Research model limit exhausted')
  const id = `${runId}/model/${sequence}`
  if (
    !(await reserveResearchSpend(
      store,
      options.campaign,
      id,
      'model',
      researchCallReservation(options.price, options.fallbackPrice),
      options.limitUsd
    ))
  )
    throw new Error(researchBudgetError)
  await store.update<Attempt[], null>(`model-attempts/${runId}`, (prior) => ({
    value: [...(prior ?? []), { id }],
    result: null,
  }))
  return {
    /** Settle the attempt by recording actual spend and usage for the run's totals. */
    async settle(costUsd: number | undefined, usage?: Record<string, number>) {
      await settleResearchModelSpend(store, options.campaign, id, costUsd)
      if (costUsd !== undefined)
        await store.update<Attempt[], null>(
          `model-attempts/${runId}`,
          (prior) => ({
            value: (prior ?? []).map((attempt) =>
              attempt.id === id ? { id, costUsd } : attempt
            ),
            result: null,
          })
        )
      if (usage)
        await store.update(`usage/${runId}`, () => ({
          value: usage,
          result: null,
        }))
    },
  }
}

/** Summarize observed model cost and attempt count for the research report. */
export async function researchModelCosts(
  store: ResearchStateStore,
  runId: string
) {
  const attempts =
    (await store.read<Attempt[]>(`model-attempts/${runId}`)) ?? []
  return {
    costUsd: attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0),
    missingModelCosts: attempts.filter(
      (attempt) => attempt.costUsd === undefined
    ).length,
    modelAttempts: attempts.length,
  }
}
