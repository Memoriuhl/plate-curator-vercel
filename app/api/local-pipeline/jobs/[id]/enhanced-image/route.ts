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
  const step = new URL(request.url).searchParams.get('step')
  const artifactId = await deps.store.transaction(async tx => {
    const job = await tx.get(id)
    const result = job?.result?.fieldSuggestion
    if (!job || job.localScope !== deps.localScope || !job.queueRunId || job.state !== 'completed' ||
      result?.kind !== 'enhanced-image' || (job.requestedBy !== auth.actor.uid && auth.actor.role !== 'owner')) return null
    const batch = await tx.batch(job.batchId)
    if (!batch || !canEdit(batch, auth.actor)) return null
    if (!step || step === result.frames?.at(-1)?.step) return id
    return result.frames?.some(frame => frame.step === step) ? `${id}--${step}` : null
  })
  if (!artifactId) return json({ error: 'not_found' }, 404)
  const image = await deps.store.readEnhancedImage(artifactId)
  return image ? json({ image: image.toString('base64') }) : json({ error: 'not_found' }, 404)
}
