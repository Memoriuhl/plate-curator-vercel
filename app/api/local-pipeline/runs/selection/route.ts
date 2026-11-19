import {
  enqueueSelection,
  localQueueEnabled,
  parseEnqueue,
} from '../../../../../lib/jobs/queue'
import { pipelineSelectionLimit } from '../../../../../lib/jobs/pipeline-selection'
import { currentActor, jobsDeps } from '../../../../../lib/server/context'
import { SHARED_DRAFT_ALIAS } from '../../../../../lib/review/draft-id'
import { batchTarget } from '../../../../../lib/server/draft-target'
import {
  queueResponse,
  startQueueWorkflow,
} from '../../../../../lib/server/local-queue'
import { badRequest, json, readJson } from '../../../../../lib/server/respond'

/**
 * Enqueue the selected plates as scoped runs. Results land in the shared draft; a
 * selection that names a new Batch (older clients) is sent to the draft too.
 */
export async function POST(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const deps = jobsDeps()
  if (!localQueueEnabled(deps)) return json({ error: 'forbidden' }, 403)
  const body = await readJson(request)
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return badRequest()
  const { batchName, ...selection } = body as Record<string, unknown>
  if (
    batchName !== undefined &&
    (typeof batchName !== 'string' || selection.batchId !== undefined)
  )
    return badRequest()
  const requested =
    batchName !== undefined ? SHARED_DRAFT_ALIAS : selection.batchId
  const batchId =
    typeof requested === 'string'
      ? await batchTarget(requested, auth.actor)
      : requested
  const input = parseEnqueue({ ...selection, batchId }, pipelineSelectionLimit)
  if (!input) return badRequest()
  const result = await enqueueSelection(deps, auth.actor, input)
  if (!result.ok) return queueResponse(result)
  // Every chunk is already durable. If a start fails, queue reconciliation retries it.
  for (let offset = 0; offset < result.value.length; offset += 8) {
    await Promise.allSettled(
      result.value.slice(offset, offset + 8).map(startQueueWorkflow)
    )
  }
  return json(
    {
      batchId: input.batchId,
      run: result.value[0],
      runIds: result.value.map((run) => run.id),
    },
    202
  )
}
