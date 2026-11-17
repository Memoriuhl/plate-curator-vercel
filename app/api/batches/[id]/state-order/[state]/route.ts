import { parseStandardChange } from '../../../../../../lib/review/standard-change'
import { reorderState } from '../../../../../../lib/review/batch'
import { parseEditableFields } from '../../../../../../lib/review/fields'
import { catalogChanged } from '../../../../../../lib/server/catalog-head'
import { currentActor, reviewDeps } from '../../../../../../lib/server/context'
import { badRequest, readJson, respond } from '../../../../../../lib/server/respond'

export async function PUT(request: Request, ctx: RouteContext<'/api/batches/[id]/state-order/[state]'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  const standard = parseStandardChange(body?.standard)
  if (standard === null) return badRequest()
  if (typeof body?.batchRevision !== 'number' || !Number.isSafeInteger(body.batchRevision) || body.batchRevision < 0 ||
    !Array.isArray(body.order) || !body.order.every((id: unknown) => typeof id === 'string')) return badRequest()
  const { id, state } = await ctx.params
  let promotion: { plateId: string; templateFamily: string } | undefined
  if (body.promotion !== undefined) {
    if (!body.promotion || typeof body.promotion !== 'object' || Array.isArray(body.promotion)) return badRequest()
    const value = body.promotion as Record<string, unknown>
    const fields = parseEditableFields({ templateFamily: value.templateFamily })
    if (typeof value.plateId !== 'string' || !value.plateId || !fields?.templateFamily) return badRequest()
    promotion = { plateId: value.plateId, templateFamily: fields.templateFamily }
  }
  const outcome = await reorderState(reviewDeps(), auth.actor, {
    batchId: id, state, batchRevision: body.batchRevision, order: body.order, promotion, standard,
  })
  if (outcome.ok) catalogChanged()
  return respond(outcome)
}
