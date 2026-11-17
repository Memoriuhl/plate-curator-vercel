import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Actor, ReviewDeps } from '../review/types'
import { canEdit, editableStates } from '../review/access'
import { plateRevision } from '../review/revision'
import { validateResearchResult, researchDraftSchema } from './validate'
import type { ResearchStore } from './store'
import type { ResearchExecutor, ResearchInput, ResearchJob, ResearchResult } from './types'

export type ResearchError = 'forbidden' | 'not_found' | 'invalid_state' | 'request_mismatch' | 'unavailable' | 'superseded' | 'claim_mismatch' | 'claim_expired' | 'stale_input' | 'invalid_result' | 'result_mismatch'
export type ResearchOutcome<T> = { ok: true; value: T } | { ok: false; error: ResearchError }
export type ResearchDeps = { store: ResearchStore; review: ReviewDeps; active(uid: string): Promise<boolean>; now(): number; id(): string; hostedEnabled: boolean; legacyRevision?: string }
export type ResearchClaim = { job: ResearchJob; claimId: string; leaseExpiresAt: number }

export async function researchInput(deps: ResearchDeps, batchId: string, plateId: string): Promise<ResearchInput | null> {
  const batch = await deps.review.store.getBatch(batchId)
  if (!batch) return null
  const baseline = await deps.review.baselineAtVersion(batch.baselineVersion, plateId)
  if (!baseline) return null
  const edit = await deps.review.store.getEdit(batchId, plateId)
  const plate = { ...baseline, ...edit?.fields }
  return { plateId, displayName: plate.displayName, state: plate.state, inputRevision: plateRevision(plate), baselineVersion: batch.baselineVersion }
}

export async function startResearch(deps: ResearchDeps, actor: Actor, request: { batchId: string; plateId: string; executor: ResearchExecutor; requestKey: string; replaceJobId?: string }): Promise<ResearchOutcome<ResearchJob>> {
  if (actor.role !== 'owner' || !(await deps.active(actor.uid))) return { ok: false, error: 'forbidden' }
  if (!['desktop', 'eve'].includes(request.executor) || !request.requestKey.trim() || request.requestKey.length > 128) return { ok: false, error: 'invalid_state' }
  if (request.executor === 'eve' ? !deps.hostedEnabled : !deps.legacyRevision) return { ok: false, error: 'unavailable' }
  const batch = await deps.review.store.getBatch(request.batchId)
  if (!batch || !canEdit(batch, actor)) return { ok: false, error: 'not_found' }
  if (!editableStates.includes(batch.state)) return { ok: false, error: 'invalid_state' }
  const input = await researchInput(deps, request.batchId, request.plateId)
  if (!input) return { ok: false, error: 'not_found' }
  const id = createHash('sha256').update(JSON.stringify([deps.store.env, actor.uid, request.batchId, request.requestKey])).digest('hex')
  return deps.store.transaction(async tx => {
    const existing = await tx.get(id)
    if (existing) return existing.executor === request.executor && existing.input.plateId === request.plateId
      ? { ok: true as const, value: existing } : { ok: false as const, error: 'request_mismatch' as const }
    const old = request.replaceJobId ? await tx.get(request.replaceJobId) : null
    if (request.replaceJobId && (!old || old.requestedBy !== actor.uid || old.batchId !== request.batchId || old.input.plateId !== request.plateId)) return { ok: false as const, error: 'not_found' as const }
    if (old?.replacedBy) return { ok: false as const, error: 'superseded' as const }
    const job: ResearchJob = { id, requestKey: request.requestKey, batchId: request.batchId, requestedBy: actor.uid, env: deps.store.env, input, executor: request.executor, model: request.executor === 'eve' ? 'openai/gpt-6.1-sol' : 'gemma4:12b', state: 'queued', createdAt: deps.now(), deadline: deps.now() + (request.executor === 'eve' ? 300000 : 86400000), counters: {}, ...(request.executor === 'desktop' ? { legacyRevision: deps.legacyRevision } : {}) }
    if (old) tx.set({ ...old, state: 'superseded', replacedBy: id })
    tx.set(job)
    return { ok: true as const, value: job }
  })
}

export async function getResearch(deps: ResearchDeps, actor: Actor, id: string): Promise<ResearchOutcome<ResearchJob>> {
  if (!(await deps.active(actor.uid))) return { ok: false, error: 'forbidden' }
  const job = await deps.store.transaction(async tx => {
    const current = await tx.get(id)
    if (current && ['queued', 'running'].includes(current.state) && current.deadline <= deps.now()) {
      const expired: ResearchJob = { ...current, state: 'expired', error: 'deadline_exhausted' }
      tx.set(expired)
      return expired
    }
    return current
  })
  const batch = job && await deps.review.store.getBatch(job.batchId)
  if (!job || !batch || !canEdit(batch, actor)) return { ok: false, error: 'not_found' }
  return { ok: true, value: job }
}

export async function claimResearch(deps: ResearchDeps, workerId: string): Promise<ResearchClaim | null> {
  return deps.store.transaction(async tx => {
    const jobs = (await tx.list()).filter(job => job.executor === 'desktop' && job.deadline > deps.now() && (job.state === 'queued' || job.state === 'running' && (job.claim?.expiresAt ?? 0) <= deps.now())).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    let job: ResearchJob | undefined
    for (const candidate of jobs) if (await deps.active(candidate.requestedBy)) { job = candidate; break }
    if (!job) return null
    const claim = { id: deps.id(), workerId, expiresAt: deps.now() + 300000 }
    const next: ResearchJob = { ...job, state: 'running', claim }
    tx.set(next)
    return { job: next, claimId: claim.id, leaseExpiresAt: claim.expiresAt }
  })
}

function claimError(job: ResearchJob, workerId: string, claimId: string, now: number): ResearchError | null {
  if (job.state === 'superseded') return 'superseded'
  if (job.claim?.id !== claimId || job.claim.workerId !== workerId) return 'claim_mismatch'
  if (job.state !== 'completed' && (job.state !== 'running' || job.claim.expiresAt <= now || job.deadline <= now)) return 'claim_expired'
  return null
}

export async function renewResearchClaim(deps: ResearchDeps, workerId: string, request: { jobId: string; claimId: string }): Promise<ResearchOutcome<ResearchClaim>> {
  return deps.store.transaction(async tx => {
    const job = await tx.get(request.jobId)
    if (!job) return { ok: false as const, error: 'not_found' as const }
    const error = claimError(job, workerId, request.claimId, deps.now())
    if (error) return { ok: false as const, error }
    if (!(await deps.active(job.requestedBy))) return { ok: false as const, error: 'forbidden' as const }
    const next = { ...job, claim: { ...job.claim!, expiresAt: Math.min(job.deadline, deps.now() + 300000) } }
    tx.set(next)
    return { ok: true as const, value: { job: next, claimId: next.claim.id, leaseExpiresAt: next.claim.expiresAt } }
  })
}

const resultSchema = z.object({
  input: z.object({ plateId: z.string(), displayName: z.string(), state: z.string(), inputRevision: z.string(), baselineVersion: z.number().int() }),
  sources: z.array(z.object({ id: z.string().max(100), kind: z.enum(['wikipedia', 'web']), title: z.string().max(300), url: z.string().url().max(2000), text: z.string().max(30000), contentHash: z.string().length(64), fetchedAt: z.string().datetime() })).max(12),
  draft: researchDraftSchema, rejected: z.array(z.unknown()).max(100),
  provenance: z.object({ executor: z.enum(['desktop', 'eve']), model: z.string().max(200), promptVersion: z.string().min(1).max(100), codeRevision: z.string().min(1).max(100) }),
  attempts: z.array(z.unknown()).max(10), durationMs: z.number().min(0).max(86400000), status: z.enum(['ok', 'partial', 'failed', 'no_sources', 'exhausted']),
  cost: z.object({ usd: z.number().nonnegative().nullable(), missing: z.number().int().nonnegative() }), counters: z.record(z.string(), z.number().nonnegative()), cache: z.enum(['fresh', 'cached', 'mixed', 'unknown']),
})

export function normalizeResearchReport(raw: unknown, job: ResearchJob): ResearchResult | null {
  const parsed = resultSchema.safeParse(raw)
  if (!parsed.success) return null
  const data = parsed.data
  if (JSON.stringify(data.input) !== JSON.stringify(job.input) || data.provenance.executor !== job.executor || data.provenance.model !== job.model || job.legacyRevision && data.provenance.codeRevision !== job.legacyRevision) return null
  if (data.sources.some(source => !['https:', 'http:'].includes(new URL(source.url).protocol) || new URL(source.url).username || new URL(source.url).password || createHash('sha256').update(source.text).digest('hex') !== source.contentHash)) return null
  const screened = validateResearchResult(data.draft, data.sources)
  return { ...data, ...screened, status: data.sources.length === 0 ? 'no_sources' : screened.draft.description && screened.draft.funFacts.length ? 'ok' : 'partial' }
}

export async function reportResearch(deps: ResearchDeps, workerId: string, request: { jobId: string; claimId: string; result: unknown }): Promise<ResearchOutcome<ResearchJob>> {
  return deps.store.transaction(async tx => {
    const job = await tx.get(request.jobId)
    if (!job) return { ok: false as const, error: 'not_found' as const }
    const error = claimError(job, workerId, request.claimId, deps.now())
    if (error) return { ok: false as const, error }
    if (!(await deps.active(job.requestedBy))) return { ok: false as const, error: 'forbidden' as const }
    const result = normalizeResearchReport(request.result, job)
    if (!result) return { ok: false as const, error: 'invalid_result' as const }
    if (job.state === 'completed') return JSON.stringify(job.result) === JSON.stringify(result) ? { ok: true as const, value: job } : { ok: false as const, error: 'result_mismatch' as const }
    const current = await researchInput({ ...deps, review: { ...deps.review, store: tx.review ?? deps.review.store } }, job.batchId, job.input.plateId)
    if (!current || current.inputRevision !== job.input.inputRevision) { tx.set({ ...job, state: 'failed', error: 'stale_input', result }); return { ok: false as const, error: 'stale_input' as const } }
    const next: ResearchJob = { ...job, state: 'completed', result, completedAt: deps.now() }
    tx.set(next)
    return { ok: true as const, value: next }
  }, deps.review.store)
}
