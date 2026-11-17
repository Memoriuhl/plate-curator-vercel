import type { Actor, EditableFields, Outcome, ReviewBatch } from '../review/types'
import type { Plate } from '../catalog/types'
import { proposeEdit } from '../review/batch'
import { plateRevision } from '../review/revision'
import { parseEditableFields } from '../review/fields'
import type { ResearchDeps, ResearchError } from './jobs'
import { validateResearchResult } from './validate'

export const researchFields = ['description', 'funFacts', 'readMore', 'wikiUrl'] as const
export type ResearchField = typeof researchFields[number]

export async function acceptResearch(deps: ResearchDeps, actor: Actor, request: { jobId: string; baseRevision: string; fields: string[]; draft?: unknown }): Promise<Outcome<{ batch: ReviewBatch; plate: Plate }> | { ok: false; error: ResearchError }> {
  if (!(await deps.active(actor.uid))) return { ok: false, error: 'forbidden' }
  if (!request.fields.length || request.fields.some(field => !researchFields.includes(field as ResearchField))) return { ok: false, error: 'invalid_result' }
  let superseded: ReviewBatch | undefined
  const outcome = await deps.store.transaction(async tx => {
    const job = await tx.get(request.jobId)
    if (!job) return { ok: false as const, error: 'not_found' as const }
    if (job.replacedBy || job.state === 'superseded') return { ok: false as const, error: 'superseded' as const }
    if (job.state !== 'completed' || !job.result) return { ok: false as const, error: 'invalid_state' as const }
    const review = { ...deps.review, store: tx.review ?? deps.review.store, supersedeRun: undefined }
    const batch = await review.store.getBatch(job.batchId)
    if (!batch) return { ok: false as const, error: 'not_found' as const }
    const baseline = await review.baselineAtVersion(batch.baselineVersion, job.input.plateId)
    if (!baseline || batch.baselineVersion !== job.input.baselineVersion) return { ok: false as const, error: 'stale_input' as const }
    const edit = await review.store.getEdit(batch.id, baseline.id)
    const currentRevision = plateRevision({ ...baseline, ...edit?.fields })
    if (currentRevision !== request.baseRevision || currentRevision !== (job.acceptedRevision ?? job.input.inputRevision)) return { ok: false as const, error: 'stale_input' as const }
    const screened = validateResearchResult(request.draft ?? job.result.draft, job.result.sources)
    if (screened.rejected.length) return { ok: false as const, error: 'invalid_result' as const }
    const { draft } = screened
    const sources = new Map(job.result.sources.map(source => [source.id, source]))
    const fields: EditableFields = {}
    for (const field of new Set(request.fields)) {
      if (field === 'description' && draft.description) fields.description = draft.description
      else if (field === 'funFacts' && draft.funFacts.length) fields.funFacts = draft.funFacts.map(fact => ({ text: fact.text, sourceUrl: sources.get(fact.sourceId)!.url, sourceTitle: sources.get(fact.sourceId)!.title }))
      else if (field === 'readMore' && draft.readMore.length) fields.readMore = draft.readMore.map(id => { const source = sources.get(id)!; return { title: source.title, url: source.url, site: new URL(source.url).hostname } })
      else if (field === 'wikiUrl' && draft.wikiSource) fields.wikiUrl = sources.get(draft.wikiSource)!.url
      else return { ok: false as const, error: 'invalid_result' as const }
    }
    if (!parseEditableFields(fields)) return { ok: false as const, error: 'invalid_result' as const }
    const result = await proposeEdit(review, actor, { batchId: batch.id, plateId: baseline.id, baseRevision: currentRevision, fields })
    if (result.ok) {
      tx.set({ ...job, acceptedRevision: plateRevision(result.value.plate), acceptedFields: [...new Set([...(job.acceptedFields ?? []), ...request.fields])] })
      superseded = batch.state !== 'open' ? batch : undefined
    }
    return result
  }, deps.review.store)
  if (outcome.ok && superseded) await deps.review.supersedeRun?.(superseded)
  return outcome
}
