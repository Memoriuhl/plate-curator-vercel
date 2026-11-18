import { canEdit } from '@/lib/review/access'
import { localQueueEnabled } from '@/lib/jobs/queue'
import { currentActor, jobsDeps } from '@/lib/server/context'
import { json } from '@/lib/server/respond'

export async function GET(request: Request, ctx: RouteContext<'/api/local-pipeline/jobs/[id]/enhanced-image'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const deps = jobsDeps()
  if (!localQueueEnabled(deps)) return json({ error: 'not_found' }, 404)
  const { id } = await ctx.params
  if (!/^[a-zA-Z0-9_-]{1,150}$/.test(id)) return json({ error: 'not_found' }, 404)
  const allowed = await deps.store.transaction(async tx => {
    const job = await tx.get(id)
    if (!job || job.localScope !== deps.localScope || !job.queueRunId || job.state !== 'completed' ||
      job.result?.fieldSuggestion?.kind !== 'enhanced-image' || (job.requestedBy !== auth.actor.uid && auth.actor.role !== 'owner')) return false
    const batch = await tx.batch(job.batchId)
    return !!batch && canEdit(batch, auth.actor)
  })
  if (!allowed) return json({ error: 'not_found' }, 404)
  const image = await deps.store.readEnhancedImage(id)
  return image ? json({ image: image.toString('base64') }) : json({ error: 'not_found' }, 404)
}
