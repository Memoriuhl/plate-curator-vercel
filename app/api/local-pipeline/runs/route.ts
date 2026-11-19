import { plateCard } from '@/lib/catalog/dashboard-build'
import { plateImageUrl } from '@/lib/catalog/image-url'
import { runPlateDetail } from '../../../../lib/jobs/run-plates'
import {
  enqueueSelection,
  listRuns,
  parseEnqueue,
  readPipelineRun,
} from '../../../../lib/jobs/queue/queue'
import type { QueueRunView } from '../../../../lib/jobs/queue/queue-types'
import { currentActor, jobsDeps } from '../../../../lib/server/context'
import { badRequest, json, readJson } from '../../../../lib/server/respond'
import { draftWriteTarget } from '../../../../lib/server/draft-target'
import {
  queueResponse,
  reconcileQueueWorkflow,
  startQueueWorkflow,
} from '../../../../lib/server/local-queue'
import { listLocalOrphanJobs } from '../../../../lib/jobs/queue/queue-failure'
import { readLocalWorkerCapabilities } from '../../../../lib/jobs/capabilities'
import { queueProgress } from '../../../../lib/jobs/run-progress'
import { recordedWorkflowUrl } from '../../../../lib/jobs/workflow-visibility'

/**
 * Reconnect the workflow from persisted state. Reads never wake it: each committed change
 * wakes it from its own route, and the workflow re-checks the stage on a timer.
 */
async function reconcileRun(run: QueueRunView) {
  if (run.status !== 'queued' && run.status !== 'running') return false
  const reconciled = await reconcileQueueWorkflow(run).catch(() => false)
  await startQueueWorkflow(run).catch(() => undefined)
  return reconciled
}

function withProgress(run: QueueRunView) {
  const progress = queueProgress(run)
  const attempt = run.attempts.at(-1)!
  progress.plateImages = Object.fromEntries(
    Object.values(attempt.projection?.plates ?? {}).flatMap(
      ({ executionPlate }) => {
        const url = plateImageUrl(
          executionPlate,
          process.env.PLATE_IMAGE_BASE ?? null
        )
        return url ? [[executionPlate.id, url]] : []
      }
    )
  )
  progress.workflowUrl = recordedWorkflowUrl(
    attempt.workflowId,
    attempt.workflowUrl
  )
  return { ...run, progress }
}

function runSummary(run: QueueRunView) {
  return {
    ...run,
    fingerprint: undefined,
    attempts: run.attempts.map((attempt) => ({
      ...Object.fromEntries(
        Object.entries(attempt).filter(
          ([key]) =>
            ![
              'projection',
              'steps',
              'completedJobIds',
              'jobIds',
              'choices',
            ].includes(key)
        )
      ),
      stepCount: attempt.steps.length,
      completedCount: attempt.completedJobIds.length,
    })),
    jobs: run.jobs
      .filter((job) => job.state === 'claimed')
      .map((job) =>
        Object.fromEntries(
          Object.entries(job).filter(
            ([key]) => key !== 'inputPlate' && key !== 'result'
          )
        )
      ),
  }
}

function runDetail(run: QueueRunView) {
  const entries = Object.values(run.attempts.at(-1)?.projection?.plates ?? {})
  return {
    ...run,
    plates: entries.map((entry) => runPlateDetail(entry.batchInput)),
    cards: entries.map((entry, index) =>
      plateCard(entry.executionPlate, index, (plate) =>
        plateImageUrl(plate, process.env.PLATE_IMAGE_BASE ?? null)
      )
    ),
    attempts: run.attempts.map((attempt, index) =>
      index === run.attempts.length - 1
        ? attempt
        : Object.fromEntries(
            Object.entries(attempt).filter(([key]) => key !== 'projection')
          )
    ),
  }
}

export async function GET(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const dependencies = jobsDeps()
  const params = new URL(request.url).searchParams
  const selectedId = params.get('detail')
  if (params.get('detailOnly') === '1') {
    if (!selectedId || selectedId === 'none') return badRequest()
    let result = await readPipelineRun(dependencies, auth.actor, selectedId)
    if (!result.ok) return queueResponse(result)
    if (await reconcileRun(result.value)) {
      result = await readPipelineRun(dependencies, auth.actor, selectedId)
      if (!result.ok) return queueResponse(result)
    }
    const selected = withProgress(result.value)
    return json({
      runs: [runSummary(selected)],
      selected: runDetail(selected),
      observedAt: dependencies.now(),
    })
  }
  const worker = await readLocalWorkerCapabilities(dependencies)
  let result = await listRuns(dependencies, auth.actor, worker, selectedId)
  if (!result.ok) return queueResponse(result)
  let reconciled = false
  for (const run of result.value) {
    if (await reconcileRun(run)) reconciled = true
  }
  if (reconciled) {
    result = await listRuns(dependencies, auth.actor, worker, selectedId)
    if (!result.ok) return queueResponse(result)
  }
  const runs = result.value.map(withProgress)
  const selected = selectedId
    ? runs.find((run) => run.id === selectedId)
    : (runs.find((run) => run.status === 'running') ?? runs[0])
  const orphanJobs = await listLocalOrphanJobs(dependencies, auth.actor)
  const capabilities = { ...worker, previewOnly: { available: true } }
  return json({
    runs: runs.map(runSummary),
    orphanJobs,
    capabilities,
    observedAt: dependencies.now(),
    ...(selected ? { selected: runDetail(selected) } : {}),
  })
}

/**
 * Validate and enqueue local pipeline work, then start the workflow for its accepted
 * run.
 */
export async function POST(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  // Runs land in the shared draft; an old Batch or a release is read-only history.
  const target =
    body && typeof body === 'object' && typeof body.batchId === 'string'
      ? await draftWriteTarget(body.batchId, auth.actor)
      : null
  if (target && !target.ok) return target.response
  const input = parseEnqueue(target ? { ...body, batchId: target.id } : body)
  if (!input) return badRequest()
  const result = await enqueueSelection(jobsDeps(), auth.actor, input)
  if (!result.ok) return queueResponse(result)
  const run = result.value[0]
  try {
    await startQueueWorkflow(run)
  } catch {
    return json({ error: 'start_failed', runId: run.id }, 503)
  }
  return queueResponse({ ok: true, value: run }, 202)
}
