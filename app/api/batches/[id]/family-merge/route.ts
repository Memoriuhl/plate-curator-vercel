import { mergeFamily } from '@/lib/review/family-merge'
import { limits } from '@/lib/review/fields'
import { currentActor, reviewDeps } from '@/lib/server/context'
import { badRequest, readJson, respond } from '@/lib/server/respond'

/** Validate the plate ID and revision used to guard each part of a family merge. */
function plateReference(
  value: unknown
): value is { id: string; revision: string } {
  if (
    !value ||
    typeof value !== 'object' ||
    !('id' in value) ||
    !('revision' in value)
  )
    return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= limits.text &&
    typeof value.revision === 'string' &&
    /^[0-9a-f]{20}$/.test(value.revision)
  )
}

/**
 * Validate a family merge request and commit it against the supplied catalog and batch
 * revisions.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/family-merge'>
) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  if (!body) return badRequest()
  const { destination, members, catalogVersion, batchRevision } = body
  if (
    !plateReference(destination) ||
    !Array.isArray(members) ||
    !members.length ||
    members.length > limits.plates ||
    !members.every(plateReference) ||
    typeof batchRevision !== 'number' ||
    !Number.isSafeInteger(batchRevision) ||
    batchRevision < 0 ||
    (catalogVersion !== undefined &&
      (typeof catalogVersion !== 'number' ||
        !Number.isSafeInteger(catalogVersion) ||
        catalogVersion < 0))
  )
    return badRequest()
  const { id } = await ctx.params
  return respond(
    await mergeFamily(reviewDeps(), auth.actor, {
      batchId: id,
      destination,
      members,
      catalogVersion,
      batchRevision,
    })
  )
}
