import { batchDetail } from '../../../../lib/review/queries'
import { currentActor, reviewDeps } from '../../../../lib/server/context'
import { badRequest, respond } from '../../../../lib/server/respond'
import { plateImageUrl } from '@/lib/catalog/image-url'

const pageSize = 100
const responseByteBudget = 2_000_000

/**
 * Read a batch detail page and enforce a single revision across its pagination cursor.
 */
export async function GET(request: Request, ctx: RouteContext<'/api/batches/[id]'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const { id } = await ctx.params
  const cursor = new URL(request.url).searchParams.get('page')
  const values = cursor === null ? null : /^(\d+)\.(\d+)$/.exec(cursor)
  if (cursor !== null && (!values || !Number.isSafeInteger(Number(values[1])) || !Number.isSafeInteger(Number(values[2])) || Number(values[2]) < 1))
    return badRequest()
  const offset = values ? Number(values[2]) : 0
  const result = await batchDetail(reviewDeps(), id, { offset, size: pageSize, ...(values ? { revision: Number(values[1]) } : {}) })
  if (!result.ok) return respond(result)
  const { batch, nextOffset } = result.value
  const plates = []
  let bytes = Buffer.byteLength(JSON.stringify(batch))
  for (const plate of result.value.plates) {
    const item = {
      ...plate,
      beforeImageUrl: plateImageUrl(plate.baseline, process.env.PLATE_IMAGE_BASE || null),
      afterImageUrl: plateImageUrl(plate.proposed, process.env.PLATE_IMAGE_BASE || null),
    }
    bytes += Buffer.byteLength(JSON.stringify(item))
    if (plates.length && bytes > responseByteBudget) break
    plates.push(item)
  }
  const next = plates.length < result.value.plates.length ? offset + plates.length : nextOffset
  return respond({ ok: true, value: { batch, plates, ...(next === undefined ? {} : { nextPage: `${batch.revision}.${next}` }) } })
}
