import { canEdit } from './batch'
import type { Actor, Outcome, ReviewDeps } from './types'

/** Check that the actor can edit an open batch before it accepts tagging work. */
export async function validateTagging(
  d: ReviewDeps,
  actor: Actor,
  batchId: string,
  plateId: string
): Promise<Outcome<null>> {
  const batch = await d.store.getBatch(batchId)
  if (!batch) return { ok: false, error: 'not_found' }
  if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
  if (batch.state !== 'open') return { ok: false, error: 'invalid_state' }
  if (!(await d.baseline(plateId))) return { ok: false, error: 'not_found' }
  return { ok: true, value: null }
}
