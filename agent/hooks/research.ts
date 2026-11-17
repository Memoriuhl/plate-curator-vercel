import { defineHook } from 'eve/hooks'
import { usage } from 'eve/events'

export default defineHook({
  events: {
    async 'turn.started'(event, ctx) {
      const { researchState } = await import('../../lib/research/storage')
      const state = await researchState()
      const costUsd = usage(ctx.view).total.costUsd ?? 0
      await state.update(`usage-start/${ctx.session.id}/${event.data.turnId}`, prior => ({ value: prior ?? costUsd, result: null }))
    },
    async 'session.started'(_event, ctx) {
      const { researchState } = await import('../../lib/research/storage')
      const { firestoreResearchStore } = await import('../../lib/research/firestore-store')
      const { researchDatabase, researchEnvironment } = await import('../../lib/research/storage')
      const principal = ctx.session.auth.initiator ?? ctx.session.auth.current
      if (!principal) throw new Error('Research requires an authenticated caller')
      const state = await researchState()
      const jobId = principal.attributes?.jobId
      const job = typeof jobId === 'string' ? await firestoreResearchStore(await researchDatabase(), researchEnvironment()).transaction(tx => tx.get(jobId)) : null
      const value = { ownerUid: principal.principalId, ...(job ? { jobId: job.id, input: job.input } : {}) }
      await state.update(`session/${ctx.session.id}`, prior => {
        if (prior && JSON.stringify(prior) !== JSON.stringify(value)) throw new Error('Session ownership differs')
        return { value, result: null }
      })
    },
    async 'turn.settled'(event, ctx) {
      const { researchState } = await import('../../lib/research/storage')
      const state = await researchState()
      const binding = await state.read<{ jobId?: string }>(`session/${ctx.session.id}`)
      const runId = binding?.jobId ?? `${ctx.session.id}/${event.data.turnId}`
      const start = await state.read<number>(`usage-start/${ctx.session.id}/${event.data.turnId}`) ?? 0
      const total = usage(ctx.view).total.costUsd
      const costUsd = total === undefined ? undefined : Math.max(0, total - start)
      const { settleResearchModelSpend } = await import('../../lib/research/budget')
      await settleResearchModelSpend(state, process.env.RESEARCH_BUDGET_ID ?? 'eve-research-1117', runId, costUsd)
      await state.update(`eve-outcome/${runId}`, () => ({ value: { outcome: event.data.outcome, ...(event.data.outcome !== 'completed' ? { error: event.data.outcome } : {}), ...(costUsd !== undefined ? { costUsd } : {}) }, result: null }))
    },
  },
})
