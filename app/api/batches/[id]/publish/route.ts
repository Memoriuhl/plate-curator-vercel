import type { PublishRequester } from '../../../../../lib/publish/types'
import { PUBLISH_STOPS } from '../../../../../lib/publish/stop'
import { randomUUID } from 'node:crypto'
import { publishControlStop } from '../../../../../lib/publish/control'
import { resumeHook } from 'workflow/api'
import { currentActiveOwner, publishAllowed, publishDeps, reviewDeps } from '../../../../../lib/server/context'
import { publishBaselineStatus } from '../../../../../lib/publish/baseline-status'
import { badRequest, json, readJson } from '../../../../../lib/server/respond'

export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/publish'>) {
  const auth = await currentActiveOwner(request)
  if (!auth.ok) return auth.response
  if (!publishAllowed()) return json({ error: 'publish_disabled_here' }, 403)

  const body = await readJson(request)
  if (typeof body?.revision !== 'number') return badRequest()

  const { id } = await ctx.params
  const deps = reviewDeps()
  const batch = await deps.store.getBatch(id)
  if (!batch) return json({ error: 'not_found' }, 404)
  if (batch.state !== 'approved' || batch.revision !== body.revision) return json({ error: 'superseded_revision' }, 409)

  const publishing = publishDeps()
  let control
  try { control = await publishing.control.read() } catch { return json({ error: 'unavailable' }, 503) }
  if (!control) return json({ error: PUBLISH_STOPS.notEnabled }, 409)
  const stop = publishControlStop(control)
  if (stop) return json({ error: stop }, 409)
  const baseline = await publishBaselineStatus(publishing, batch)
  if (baseline.error) return json(baseline, 409)
  try {
    const command: PublishRequester = { ownerUid: auth.actor.uid, generation: control.generation, commandId: randomUUID() }
    await resumeHook(`publish:${id}:${body.revision}`, command)
  } catch {
    return json({ error: 'not_waiting' }, 409)
  }
  await deps.store.requestPublish(id, body.revision, deps.now())
  return json({ status: 'publishing' }, 202)
}

export async function GET(request: Request, ctx: RouteContext<'/api/batches/[id]/publish'>) {
  const auth = await currentActiveOwner(request)
  if (!auth.ok) return auth.response
  const { id } = await ctx.params
  const batch = await reviewDeps().store.getBatch(id)
  if (!batch) return json({ error: 'not_found' }, 404)
  try {
    const publishing = publishDeps()
    const stop = publishControlStop(await publishing.control.read())
    if (stop) return json({ error: stop })
    return json(await publishBaselineStatus(publishing, batch))
  } catch { return json({ error: 'unavailable' }, 503) }
}
