import { createHash } from 'node:crypto'
import { enqueueSelection, localQueueEnabled, parseEnqueue } from '../../../../../lib/jobs/queue'
import { pipelineSelectionLimit } from '../../../../../lib/jobs/pipeline-selection'
import { catalog, currentActor, jobsDeps } from '../../../../../lib/server/context'
import { catalogChanged } from '../../../../../lib/server/catalog-head'
import { queueResponse, startQueueWorkflow } from '../../../../../lib/server/local-queue'
import { badRequest, json, readJson } from '../../../../../lib/server/respond'

/**
 * Enqueue the selected plates as scoped runs and create a draft batch when the selection
 * needs one.
 */
export async function POST(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const deps = jobsDeps()
  if (!localQueueEnabled(deps)) return json({ error: 'forbidden' }, 403)
  const body = await readJson(request)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest()
  const { batchName, ...selection } = body as Record<string, unknown>
  const name = typeof batchName === 'string' ? batchName.trim() : null
  if (batchName !== undefined && (!name || name.length > 120 || selection.batchId !== undefined)) return badRequest()
  const batchId = name
    ? createHash('sha256').update(JSON.stringify([deps.store.env, auth.actor.uid, selection.requestId, 'pipeline-draft'])).digest('hex')
    : selection.batchId
  const input = parseEnqueue({ ...selection, batchId }, pipelineSelectionLimit)
  if (!input || name && input.previewOnly) return badRequest()
  const draft = name ? { name, baselineVersion: (await catalog().readSnapshot()).version } : undefined
  const result = await enqueueSelection(deps, auth.actor, input, draft)
  if (!result.ok) return queueResponse(result)
  if (draft) catalogChanged()
  // Every chunk is already durable. If a start fails, queue reconciliation retries it.
  for (let offset = 0; offset < result.value.length; offset += 8) {
    await Promise.allSettled(result.value.slice(offset, offset + 8).map(startQueueWorkflow))
  }
  return json({ batchId: input.batchId, run: result.value[0], runIds: result.value.map(run => run.id) }, 202)
}
