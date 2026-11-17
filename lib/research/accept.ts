import type { Actor, EditableFields, Outcome, ReviewBatch } from '../review/types'
import type { Plate } from '../catalog/types'
import { proposeEdit } from '../review/batch'
import { plateRevision } from '../review/revision'
import { parseEditableFields, parseStoryFields } from '../review/fields'
import type { ResearchDeps, ResearchError } from './jobs'
import type { EvidenceSource } from './types'
import { validateResearchResult } from './validate'

export const researchFields = ['description', 'funFacts', 'readMore', 'wikiUrl'] as const
export type ResearchField = typeof researchFields[number]

function citationLabels(source: EvidenceSource) {
  const site = new URL(source.url).hostname.slice(0, 200)
  return { title: source.title.trim().slice(0, 200) || site, site }
}

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
      else if (field === 'funFacts' && draft.funFacts.length) fields.funFacts = draft.funFacts.map(fact => { const source = sources.get(fact.sourceId)!; return { text: fact.text, sourceUrl: source.url, sourceTitle: citationLabels(source).title } })
      else if (field === 'readMore' && draft.readMore.length) fields.readMore = draft.readMore.map(id => { const source = sources.get(id)!; return { ...citationLabels(source), url: source.url } })
      else if (field === 'wikiUrl' && draft.wikiSource) fields.wikiUrl = sources.get(draft.wikiSource)!.url
      else return { ok: false as const, error: 'invalid_result' as const }
    }
    const { description, ...story } = fields
    const descriptionFields = description === undefined ? {} : parseEditableFields({ description })
    const storyFields = Object.keys(story).length ? parseStoryFields(story) : {}
    if (!descriptionFields || !storyFields) return { ok: false as const, error: 'invalid_result' as const }
    const result = await proposeEdit(review, actor, { batchId: batch.id, plateId: baseline.id, baseRevision: currentRevision, fields: { ...descriptionFields, ...storyFields } })
    if (result.ok) {
      tx.set({ ...job, acceptedRevision: plateRevision(result.value.plate), acceptedFields: [...new Set([...(job.acceptedFields ?? []), ...request.fields])] })
      superseded = batch.state !== 'open' ? batch : undefined
    }
    return result
  }, deps.review.store)
  if (outcome.ok && superseded) await deps.review.supersedeRun?.(superseded)
  return outcome
}
