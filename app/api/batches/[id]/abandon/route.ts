import { abandonPreparedSnapshot, abandonedReceiptId } from '../../../../../lib/publish/abandon'
import { receiptId } from '../../../../../lib/publish/command'
import { publishCommandKey } from '../../../../../lib/publish/control'
import { validCommandId } from '../../../../../lib/publish/types'
import { currentActiveOwner, publishAllowed, publishDeps } from '../../../../../lib/server/context'
import { badRequest, json, readJson } from '../../../../../lib/server/respond'

/**
 * Authorize an owner to abandon a prepared publish receipt after validating its command
 * and revision.
 */
export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/abandon'>) {
  try {
    const auth = await currentActiveOwner(request)
    if (!auth.ok) return auth.response
    if (!publishAllowed()) return json({ error: 'publish_disabled_here' }, 403)
    const body = await readJson(request)
    if (!Number.isSafeInteger(body?.revision) || (body?.revision as number) < 0 || typeof body?.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000) return badRequest()
    const { id } = await ctx.params
    const key = receiptId(id, body.revision as number)
    const legacy = body.commandId === `${key}:legacy`
    if (!legacy && !validCommandId(body.commandId)) return badRequest()
    const deps = publishDeps()
    const archived = await deps.records.get(abandonedReceiptId({ id: key, ...(legacy ? {} : { commandId: body.commandId as string }) }))
    const record = archived ?? await deps.records.get(key)
    if (!record) return json({ error: 'not_found' }, 404)
    if ((record.abandonment?.commandId ?? publishCommandKey(record)) !== body.commandId) return json({ error: 'superseded' }, 409)
    const actor = { uid: auth.actor.uid, email: auth.actor.email, authorityEpoch: auth.actor.authorityEpoch }
    const result = await abandonPreparedSnapshot(deps, actor, record, body.reason.trim())
    return result.ok ? json({ abandonment: result.value }) : json({ error: result.error }, result.error === 'forbidden' ? 403 : result.error === 'unavailable' ? 503 : 409)
  } catch { return json({ error: 'unavailable' }, 503) }
}
