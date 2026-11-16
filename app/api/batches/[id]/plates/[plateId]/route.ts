import { proposeEdit } from '../../../../../../lib/review/batch'
import { parseEditableFields } from '../../../../../../lib/review/fields'
import { catalogChanged } from '../../../../../../lib/server/catalog-head'
import { currentActor, reviewDeps } from '../../../../../../lib/server/context'
import { badRequest, readJson, respond } from '../../../../../../lib/server/respond'

export async function PATCH(request: Request, ctx: RouteContext<'/api/batches/[id]/plates/[plateId]'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const body = await readJson(request)
  const fields = parseEditableFields(body?.fields)
  if (typeof body?.baseRevision !== 'string' || fields === null) return badRequest()

  const { id, plateId } = await ctx.params
  const outcome = await proposeEdit(reviewDeps(), auth.actor, {
    batchId: id,
    plateId,
    baseRevision: body.baseRevision,
    fields,
  })
  if (outcome.ok) catalogChanged()
  return respond(outcome)
}
