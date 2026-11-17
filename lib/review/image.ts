import { createHash } from 'node:crypto'
import { getJobForActor } from '../jobs/jobs'
import { parseFieldSuggestion } from '../jobs/suggestions'
import type { JobsDeps } from '../jobs/types'
import { readCommonsImage } from '../../worker/remote-image'
import { proposeEdit } from './batch'
import { canEdit } from './access'
import { parseEditableFields } from './fields'
import type { Actor, Outcome, ReviewDeps, ReviewBatch } from './types'
import type { Plate } from '../catalog/types'
import type { ImageCandidate } from '../jobs/specialized-suggestions'

export async function verifiedImageFields(candidate: ImageCandidate, readImage = readCommonsImage) {
  try {
    const bytes = await readImage(candidate.imageUrl)
    if (createHash('sha256').update(bytes).digest('hex') !== candidate.sha256) return null
  } catch { return null }
  return parseEditableFields({ imageUrl: candidate.imageUrl, sourceUrl: candidate.sourceUrl }, candidate)
}

export async function acceptImage(d: ReviewDeps, jobs: JobsDeps, actor: Actor, input: { batchId: string; jobId: string; candidateId: string; baseRevision: string }, readImage = readCommonsImage): Promise<Outcome<{ batch: ReviewBatch; plate: Plate }>> {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1' || !jobs.localScope) return { ok: false, error: 'forbidden' }
  const found = await getJobForActor(jobs, actor, input.jobId)
  if (!found.ok) return found
  const job = found.value
  if (job.batchId !== input.batchId || job.localScope !== jobs.localScope || job.state !== 'completed' || job.stage !== 'find-image' || 'queueRunId' in job && job.queueRunId) return { ok: false, error: 'invalid_state' }
  if (job.inputHash !== input.baseRevision) return { ok: false, error: 'stale_plate' }
  const batch = await d.store.getBatch(input.batchId)
  if (!batch) return { ok: false, error: 'not_found' }
  if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
  if (batch.state !== 'open') return { ok: false, error: 'invalid_state' }
  const result = parseFieldSuggestion(job.result?.fieldSuggestion, 'find-image')
  const candidate = result?.kind === 'image' ? result.candidates.find(value => value.id === input.candidateId) : undefined
  if (!candidate) return { ok: false, error: 'invalid_state' }
  const fields = await verifiedImageFields(candidate, readImage)
  return fields ? proposeEdit(d, actor, { batchId: input.batchId, plateId: job.plateId, baseRevision: input.baseRevision, fields }) : { ok: false, error: 'invalid_state' }
}
