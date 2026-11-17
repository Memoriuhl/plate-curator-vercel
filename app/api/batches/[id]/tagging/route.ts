import { start } from 'workflow/api'
import { canEdit } from '../../../../../lib/review/batch'
import { currentActor, reviewDeps, taggingBackend } from '../../../../../lib/server/context'
import { badRequest, json, readJson, respond } from '../../../../../lib/server/respond'
import { batchTaggingRun } from '../../../../../workflows/hosted-tagging'

const MAX_BATCH_TAGGING = 500

export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/tagging'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  if (taggingBackend() !== 'hosted') return respond({ ok: false, error: 'invalid_state' })

  const { id } = await ctx.params
  const body = await readJson(request)
  if (!body) return badRequest()
  const requested = body.plateIds
  if (requested !== undefined && (!Array.isArray(requested) || !requested.every(value => typeof value === 'string'))) return badRequest()

  const deps = reviewDeps()
  const batch = await deps.store.getBatch(id)
  if (!batch) return respond({ ok: false, error: 'not_found' })
  if (!canEdit(batch, auth.actor)) return respond({ ok: false, error: 'forbidden' })
  if (batch.state !== 'open') return respond({ ok: false, error: 'invalid_state' })

  const plateIds = [...new Set((requested as string[] | undefined) ?? batch.plateIds)]
  if (plateIds.length === 0 || plateIds.length > MAX_BATCH_TAGGING) return badRequest()
  const members = new Set(batch.plateIds)
  if (!plateIds.every(plateId => members.has(plateId))) return respond({ ok: false, error: 'not_found' })

  const requests = plateIds.map(plateId => ({ jobId: crypto.randomUUID(), plateId }))
  const run = await start(batchTaggingRun, [id, requests, auth.actor.uid])
  return json({ runId: run.runId, jobs: requests }, 202)
}
