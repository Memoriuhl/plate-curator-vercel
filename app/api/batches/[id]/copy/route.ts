import { copyBatch } from '../../../../../lib/review/copy'
import { currentActor, publishDeps, reviewEnv } from '../../../../../lib/server/context'
import { badRequest, json, readJson } from '../../../../../lib/server/respond'

export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/copy'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  if (auth.actor.role !== 'owner') return json({ error: 'forbidden' }, 403)
  const body = await readJson(request)
  if (typeof body?.revision !== 'number' || !Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.targetVersion !== 'number' || !Number.isSafeInteger(body.targetVersion) || body.targetVersion < 0) return badRequest()
  const { id } = await ctx.params
  try {
    const deps = publishDeps()
    const result = await copyBatch({ store: deps.store, head: async () => (await deps.pointer.read()).version, snapshot: version => deps.snapshots.read(version), env: reviewEnv(), now: deps.now }, auth.actor, { sourceId: id, sourceRevision: body.revision, targetVersion: body.targetVersion })
    return result.ok ? json({ ...result.value, ...(result.warnings?.length ? { warnings: result.warnings } : {}) }) : json(result, result.error === 'forbidden' ? 403 : result.error === 'not_found' ? 404 : 409)
  } catch {
    return json({ ok: false, error: 'unavailable' }, 503)
  }
}
