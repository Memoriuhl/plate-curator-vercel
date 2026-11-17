import { defineAgent, defineDynamic } from 'eve'
import { position } from 'eve/events'

export default defineAgent({
  defaultTools: false,
  model: defineDynamic(ctx => ctx.memo(['research-model', ctx.turn?.id, position(ctx.view)], async () => {
    if (process.env.RESEARCH_ENABLE_MODEL_CALLS !== 'true') throw new Error('Research model calls are disabled. Configure the authorized pilot before enabling RESEARCH_ENABLE_MODEL_CALLS.')
    const { reserveResearchCall } = await import('../lib/research/limits')
    const { researchState } = await import('../lib/research/storage')
    const store = await researchState()
    const runId = `${ctx.session.id}/${ctx.turn?.id ?? 'initial'}`
    const deadline = await store.update<number, number>(`deadline/${runId}`, prior => ({ value: prior ?? Date.now() + 300000, result: prior ?? Date.now() + 300000 }))
    if (await reserveResearchCall(runId, 'model', { store, now: Date.now, deadline }) !== 'reserved') throw new Error('Research model limit or deadline exhausted')
    return 'openai/gpt-6.1-sol'
  })),
  limits: { sessionUsage: ({ total }) => total.inputTokens - total.cacheReadTokens >= 50000 || total.outputTokens >= 10000 || (total.costUsd ?? 0) >= 0.1 },
})
