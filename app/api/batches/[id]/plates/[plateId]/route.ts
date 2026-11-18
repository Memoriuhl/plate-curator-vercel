import { parseStandardChange } from '../../../../../../lib/review/standard-change'
import {
  proposeEdit,
  revertPipelineField,
} from '../../../../../../lib/review/batch'
import { discardPlateChanges } from '../../../../../../lib/review/discard-changes'
import {
  editableKeys,
  parseEditableFields,
} from '../../../../../../lib/review/fields'
import { catalogChanged } from '../../../../../../lib/server/catalog-head'
import { currentActor, reviewDeps } from '../../../../../../lib/server/context'
import {
  badRequest,
  readJson,
  respond,
} from '../../../../../../lib/server/respond'

/** Apply a validated field edit or pipeline revert to the current batch draft. */
export async function PATCH(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/plates/[plateId]'>
) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const body = await readJson(request)
  const { id, plateId } = await ctx.params
  if (body?.discard !== undefined) {
    const { batchRevision, discard } = body
    const target =
      discard === 'order' || discard === 'all'
        ? discard
        : editableKeys.find((field) => field === discard)
    if (
      !target ||
      typeof batchRevision !== 'number' ||
      !Number.isSafeInteger(batchRevision) ||
      batchRevision < 0
    )
      return badRequest()
    const outcome = await discardPlateChanges(reviewDeps(), auth.actor, {
      batchId: id,
      plateId,
      batchRevision,
      target,
    })
    if (outcome.ok) catalogChanged()
    return respond(outcome)
  }
  if (body?.revert !== undefined) {
    const field = editableKeys.find((key) => key === body.revert)
    if (!field || typeof body.jobId !== 'string' || !body.jobId)
      return badRequest()
    const outcome = await revertPipelineField(reviewDeps(), auth.actor, {
      batchId: id,
      plateId,
      field,
      jobId: body.jobId,
    })
    if (outcome.ok) catalogChanged()
    return respond(outcome)
  }

  const standard = parseStandardChange(body?.standard)
  if (standard === null) return badRequest()
  const fields = parseEditableFields(body?.fields)
  if (typeof body?.baseRevision !== 'string' || fields === null)
    return badRequest()

  const outcome = await proposeEdit(reviewDeps(), auth.actor, {
    batchId: id,
    plateId,
    baseRevision: body.baseRevision,
    fields,
    standard,
  })
  if (outcome.ok) catalogChanged()
  return respond(outcome)
}
