import type { ResearchDeps } from './jobs'
import { normalizeResearchReport, researchInput } from './jobs'
import { hostedResearchResult } from './runtime'
import type { ResearchStateStore } from './state'
import type { ResearchJob, ResearchResult } from './types'

export async function dispatchEveResearch(deps: ResearchDeps, id: string, create: (job: ResearchJob) => Promise<{ sessionId: string; deliveryId: string }>): Promise<ResearchJob | null> {
  const job = await deps.store.transaction(async tx => {
    const current = await tx.get(id)
    if (!current || current.executor !== 'eve' || !['queued', 'running'].includes(current.state) || current.eve) return current
    if (current.deadline <= deps.now()) { const expired: ResearchJob = { ...current, state: 'expired', error: 'deadline_exhausted' }; tx.set(expired); return expired }
    if (!(await deps.active(current.requestedBy))) { const failed: ResearchJob = { ...current, state: 'failed', error: 'requester_removed' }; tx.set(failed); return failed }
    const next: ResearchJob = { ...current, state: 'running', dispatchStartedAt: current.dispatchStartedAt ?? deps.now() }
    tx.set(next)
    return next
  })
  if (!job || job.eve || job.state !== 'running') return job
  const receipt = await create(job)
  return deps.store.transaction(async tx => {
    const current = await tx.get(id)
    if (!current || current.state !== 'running') return current
    const next = { ...current, eve: receipt }
    tx.set(next)
    return next
  }, deps.review.store)
}

export async function finishEveResearch(deps: ResearchDeps, id: string, state: ResearchStateStore): Promise<ResearchJob | null> {
  const current = await deps.store.transaction(tx => tx.get(id))
  if (!current || current.state !== 'running') return current
  const output = await state.read<Pick<ResearchResult, 'draft' | 'sources' | 'rejected'>>(`draft/${id}`)
  const settled = await state.read<{ outcome: string; error?: string; costUsd?: number; missingModelCosts?: number }>(`eve-outcome/${id}`)
  if (!settled && current.deadline > deps.now()) return current
  const counters = await state.read<Record<string, number>>(`limits/${id}`) ?? {}
  const nativeCost = await state.read<{ usd: number; missing: number }>(`native-search-cost/${id}`)
  const active = await deps.active(current.requestedBy)
  return deps.store.transaction(async tx => {
    const job = await tx.get(id)
    if (!job || job.state !== 'running') return job
    let next: ResearchJob
    if (!active) next = { ...job, state: 'failed', error: 'requester_removed' }
    else if (output) {
      const input = await researchInput({ ...deps, review: { ...deps.review, store: tx.review ?? deps.review.store } }, job.batchId, job.input.plateId)
      const result = normalizeResearchReport(hostedResearchResult(job.input, output, { durationMs: Math.max(0, deps.now() - job.createdAt), counters, model: job.model }), job)
      if (result && settled?.costUsd !== undefined) result.cost = { usd: settled.costUsd + (nativeCost?.usd ?? 0), missing: (settled.missingModelCosts ?? 0) + (nativeCost ? nativeCost.missing : Number(!!counters['web-search'])) }
      if (!result) next = { ...job, state: 'failed', error: 'invalid_result' }
      else if (input?.inputRevision !== job.input.inputRevision) next = { ...job, state: 'failed', error: 'stale_input', result }
      else next = { ...job, state: 'completed', result, completedAt: deps.now() }
    } else next = { ...job, state: job.deadline <= deps.now() ? 'expired' : 'failed', error: settled?.error ?? 'no_structured_draft' }
    tx.set(next)
    return next
  }, deps.review.store)
}
