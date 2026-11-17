import { randomUUID } from 'node:crypto'
import { membersStore } from '../../../../../lib/server/members'
import { isActiveOwner } from '../../../../../lib/members/member'
import { publishControlStop } from '../../../../../lib/publish/control'
import { resumeHook } from 'workflow/api'
import { currentActor, publishAllowed, publishDeps, reviewDeps } from '../../../../../lib/server/context'
import { publishBaselineStatus } from '../../../../../lib/publish/baseline-status'
import { badRequest, json, readJson } from '../../../../../lib/server/respond'

export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/publish'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  if (auth.actor.role !== 'owner') return json({ error: 'forbidden' }, 403)
  const member = await membersStore().getByUid(auth.actor.uid)
  if (!member || !isActiveOwner(member)) return json({ error: 'forbidden' }, 403)
  if (!publishAllowed()) return json({ error: 'publish_disabled_here' }, 403)

  const publishing = publishDeps()
  let control
  try { control = await publishing.control.read() } catch { return json({ error: 'unavailable' }, 503) }
  const stop = publishControlStop(control)
  if (stop) return json({ error: stop }, 409)
  const body = await readJson(request)
  if (typeof body?.revision !== 'number') return badRequest()

  const { id } = await ctx.params
  const deps = reviewDeps()
  const batch = await deps.store.getBatch(id)
  if (!batch) return json({ error: 'not_found' }, 404)
  if (batch.state !== 'approved' || batch.revision !== body.revision) return json({ error: 'superseded_revision' }, 409)

  const baseline = await publishBaselineStatus(publishing, batch)
  if (baseline.error) return json(baseline, 409)
  try {
    await resumeHook(`publish:${id}:${body.revision}`, { ownerUid: auth.actor.uid, generation: control!.generation, commandId: randomUUID() })
  } catch {
    return json({ error: 'not_waiting' }, 409)
  }
  await deps.store.requestPublish(id, body.revision, deps.now())
  return json({ status: 'publishing' }, 202)
}

export async function GET(request: Request, ctx: RouteContext<'/api/batches/[id]/publish'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  if (auth.actor.role !== 'owner') return json({ error: 'forbidden' }, 403)
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
