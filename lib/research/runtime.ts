import { researchState } from './storage'
import { reserveResearchCall, type ResearchCall } from './limits'
import { saveEvidence } from './evidence'
import type { EvidenceSource, ResearchInput, ResearchResult } from './types'
import { validateResearchResult } from './validate'
import type { ResearchStateStore } from './state'

type SessionContext = { session: { id: string; turn: { id: string } } }
export type ResearchSessionBinding = { ownerUid: string; jobId?: string; input?: ResearchInput }

export async function researchTurn(ctx: SessionContext, providedStore?: ResearchStateStore) {
  const store = providedStore ?? await researchState()
  const binding = await store.read<ResearchSessionBinding>(`session/${ctx.session.id}`)
  const runId = binding?.jobId ?? `${ctx.session.id}/${ctx.session.turn.id}`
  const deadline = await store.update<number, number>(`deadline/${runId}`, prior => {
    const value = prior ?? Date.now() + 300000
    return { value, result: value }
  })
  return {
    store, runId, deadline, binding,
    async reserve(kind: ResearchCall) { return await reserveResearchCall(runId, kind, { store, now: Date.now, deadline }) === 'reserved' },
    async evidence(source: EvidenceSource) { return saveEvidence(store, runId, source) },
  }
}

export async function submitResearchDraft(ctx: SessionContext, raw: unknown, providedStore?: ResearchStateStore) {
  const runtime = await researchTurn(ctx, providedStore)
  const sources = await runtime.store.read<EvidenceSource[]>(`evidence/${runtime.runId}`) ?? []
  const { draft, rejected } = validateResearchResult(raw, sources)
  const result = { draft, rejected, sources }
  await runtime.store.update(`draft/${runtime.runId}`, () => ({ value: result, result: null }))
  return { status: sources.length === 0 ? 'no_sources' : draft.description && draft.funFacts.length ? 'ok' : 'partial', ...result }
}

export function hostedResearchResult(input: ResearchInput, output: { draft: ResearchResult['draft']; sources: EvidenceSource[]; rejected: ResearchResult['rejected'] }, details: { durationMs: number; counters: Record<string, number> }): ResearchResult {
  return {
    input, ...output, ...details,
    provenance: { executor: 'eve', model: 'openai/gpt-6.1-sol', promptVersion: 'research-v1', codeRevision: process.env.VERCEL_GIT_COMMIT_SHA ?? 'development' },
    attempts: [], status: output.sources.length === 0 ? 'no_sources' : output.draft.description && output.draft.funFacts.length > 0 ? 'ok' : 'partial',
    cost: { usd: null, missing: 1 }, cache: 'unknown',
  }
}
