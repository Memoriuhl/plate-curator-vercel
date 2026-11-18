import { localQueueEnabled } from '@/lib/jobs/queue'
import { canEdit } from '@/lib/review/access'
import { currentActor, jobsDeps } from '@/lib/server/context'
import { json } from '@/lib/server/respond'

export async function GET(request: Request, ctx: RouteContext<'/api/local-pipeline/plates/[id]/enhancement'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const deps = jobsDeps()
  if (!localQueueEnabled(deps)) return json({ error: 'not_found' }, 404)
  const { id } = await ctx.params
  if (!id || id.length > 150 || id.includes('/')) return json({ error: 'not_found' }, 404)

  const result = await deps.store.transaction(async tx => {
    const recent = (await tx.list(id)).filter(job => job.localScope === deps.localScope && job.queueRunId &&
      job.state === 'completed' && job.result?.fieldSuggestion?.kind === 'enhanced-image' &&
      (job.requestedBy === auth.actor.uid || auth.actor.role === 'owner'))
      .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt) || b.id.localeCompare(a.id))
    for (const job of recent) {
      const batch = await tx.batch(job.batchId)
      if (batch && canEdit(batch, auth.actor)) {
        return { jobId: job.id, suggestion: job.result!.fieldSuggestion! }
      }
    }
    return null
  })
  return json({ result })
}
