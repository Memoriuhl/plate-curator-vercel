import { defineHook } from 'eve/hooks'

export default defineHook({
  events: {
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
      const { researchModelCosts } = await import('../../lib/research/model-attempt')
      const costs = await researchModelCosts(state, runId)
      await state.update(`eve-outcome/${runId}`, () => ({ value: { outcome: event.data.outcome, ...(event.data.outcome !== 'completed' ? { error: event.data.outcome } : {}), ...costs }, result: null }))
    },
  },
})
