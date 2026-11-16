import { proposeEdit } from '../../../../../../lib/review/batch'
import type { EditableFields } from '../../../../../../lib/review/types'
import { currentActor, reviewDeps } from '../../../../../../lib/server/context'
import { badRequest, readJson, respond } from '../../../../../../lib/server/respond'

export async function PATCH(request: Request, ctx: RouteContext<'/api/batches/[id]/plates/[plateId]'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const body = await readJson(request)
  if (typeof body?.baseRevision !== 'string' || typeof body.fields !== 'object' || body.fields === null) {
    return badRequest()
  }

  const { id, plateId } = await ctx.params
  return respond(await proposeEdit(reviewDeps(), auth.actor, {
    batchId: id,
    plateId,
    baseRevision: body.baseRevision,
    fields: body.fields as EditableFields,
  }))
}
