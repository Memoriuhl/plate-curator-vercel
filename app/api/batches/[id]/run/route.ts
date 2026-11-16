import { getRun } from 'workflow/api'
import { approvalRunStatus, type ApprovalResult } from '../../../../../lib/review/run-status'
import { currentActor, reviewDeps } from '../../../../../lib/server/context'
import { json } from '../../../../../lib/server/respond'

export async function GET(request: Request, ctx: RouteContext<'/api/batches/[id]/run'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  if (auth.actor.role !== 'owner') return json({ error: 'forbidden' }, 403)
  const { id } = await ctx.params
  const batch = await reviewDeps().store.getBatch(id)
  if (!batch) return json({ error: 'not_found' }, 404)
  if (!batch.approvalRun) return json(approvalRunStatus(batch))
  const run = getRun<ApprovalResult>(batch.approvalRun.runId)
  const status = await run.status
  const [completedAt, startedAt, createdAt] = await Promise.all([run.completedAt, run.startedAt, run.createdAt])
  return json(approvalRunStatus(batch, {
    status,
    ...(status === 'completed' ? { result: await run.returnValue } : {}),
    updatedAt: (completedAt ?? startedAt ?? createdAt).toISOString(),
  }))
}
