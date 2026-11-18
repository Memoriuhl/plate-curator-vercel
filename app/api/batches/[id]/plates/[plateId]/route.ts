import { parseStandardChange } from '../../../../../../lib/review/standard-change'
import { proposeEdit, revertPipelineField } from '../../../../../../lib/review/batch'
import { editableKeys, parseEditableFields } from '../../../../../../lib/review/fields'
import { catalogChanged } from '../../../../../../lib/server/catalog-head'
import { currentActor, reviewDeps } from '../../../../../../lib/server/context'
import { badRequest, readJson, respond } from '../../../../../../lib/server/respond'

export async function PATCH(request: Request, ctx: RouteContext<'/api/batches/[id]/plates/[plateId]'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const body = await readJson(request)
  const { id, plateId } = await ctx.params
  if (body?.revert !== undefined) {
    const field = editableKeys.find(key => key === body.revert)
    if (!field || typeof body.jobId !== 'string' || !body.jobId) return badRequest()
    const outcome = await revertPipelineField(reviewDeps(), auth.actor, { batchId: id, plateId, field, jobId: body.jobId })
    if (outcome.ok) catalogChanged()
    return respond(outcome)
  }

  const standard = parseStandardChange(body?.standard)
  if (standard === null) return badRequest()
  const fields = parseEditableFields(body?.fields)
  if (typeof body?.baseRevision !== 'string' || fields === null) return badRequest()

  const outcome = await proposeEdit(reviewDeps(), auth.actor, {
    batchId: id,
    plateId,
    baseRevision: body.baseRevision,
    fields, standard,
  })
  if (outcome.ok) catalogChanged()
  return respond(outcome)
}
