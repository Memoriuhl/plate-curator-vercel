import { batchDetail } from '../../../../lib/review/queries'
import { currentActor, reviewDeps } from '../../../../lib/server/context'
import { respond } from '../../../../lib/server/respond'
import { plateImageUrl } from '@/lib/catalog/image-url'

export async function GET(request: Request, ctx: RouteContext<'/api/batches/[id]'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const { id } = await ctx.params
  const result = await batchDetail(reviewDeps(), id)
  if (!result.ok) return respond(result)
  return respond({ ok: true, value: {
    ...result.value,
    plates: result.value.plates.map(entry => ({
      ...entry,
      beforeImageUrl: plateImageUrl(entry.baseline, process.env.PLATE_IMAGE_BASE || null),
      afterImageUrl: plateImageUrl(entry.proposed, process.env.PLATE_IMAGE_BASE || null),
    })),
  } })
}
