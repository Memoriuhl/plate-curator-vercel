import { defineAgent, defineDynamic } from 'eve'
import { gateway } from 'ai'
import { guardedResearchModel } from '../lib/research/model'

export default defineAgent({
  defaultTools: false,
  reasoning: 'low',
  model: defineDynamic(ctx => guardedResearchModel(gateway('openai/gpt-6.1-sol'), async () => {
    if (process.env.RESEARCH_ENABLE_MODEL_CALLS !== 'true') throw new Error('Research model calls are disabled. Configure the authorized pilot before enabling RESEARCH_ENABLE_MODEL_CALLS.')
    const { researchTurn } = await import('../lib/research/runtime')
    const run = await researchTurn({ session: { ...ctx.session, turn: { id: ctx.turn?.id ?? 'initial' } } })
    return run.modelAttempt()
  })),
  limits: { sessionUsage: ({ total }) => total.inputTokens - total.cacheReadTokens >= 50000 || total.outputTokens >= 10000 || (total.costUsd ?? 0) >= 0.1 },
})
