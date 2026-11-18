import { plateCard } from '@/lib/catalog/dashboard-build'
import { plateImageUrl } from '@/lib/catalog/image-url'
import { runPlateDetail } from '../../../../lib/jobs/run-plates'
import { enqueueSelection, listRuns, parseEnqueue } from '../../../../lib/jobs/queue'
import { currentActor, jobsDeps } from '../../../../lib/server/context'
import { badRequest, json, readJson } from '../../../../lib/server/respond'
import { queueResponse, reconcileQueueWorkflow, startQueueWorkflow, wakeLocalJob } from '../../../../lib/server/local-queue'
import { listLocalOrphanJobs } from '../../../../lib/jobs/queue-failure'
import { readLocalWorkerCapabilities } from '../../../../lib/jobs/capabilities'
import { queueProgress } from '../../../../lib/jobs/run-progress'
import { recordedWorkflowUrl } from '../../../../lib/jobs/workflow-visibility'

export async function GET(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const dependencies = jobsDeps()
  const worker = await readLocalWorkerCapabilities(dependencies)
  const selectedId = new URL(request.url).searchParams.get('detail')
  let result = await listRuns(dependencies, auth.actor, worker, selectedId)
  if (!result.ok) return queueResponse(result)
  let reconciled = false
  for (const run of result.value) {
    if (run.status !== 'queued' && run.status !== 'running') continue
    if (await reconcileQueueWorkflow(run).catch(() => false)) reconciled = true
    await startQueueWorkflow(run).catch(() => undefined)
    const attempt = run.attempts.at(-1)!
    const current = run.jobs.find(job => job.queueAttempt === attempt.number && job.queueStep === attempt.cursor)
    if (current && current.state !== 'queued' && (current.state !== 'claimed' || run.waitReason === 'resource')) await wakeLocalJob(current)
  }
  if (reconciled) { result = await listRuns(dependencies, auth.actor, worker, selectedId); if (!result.ok) return queueResponse(result) }
  const selected = selectedId ? result.value.find(run => run.id === selectedId) : result.value.find(run => run.status === 'running') ?? result.value[0]
  for (const run of result.value) {
    run.progress = queueProgress(run)
    const attempt = run.attempts.at(-1)!
    run.progress.plateImages = Object.fromEntries(Object.values(attempt.projection?.plates ?? {}).flatMap(({ executionPlate }) => {
      const url = plateImageUrl(executionPlate, process.env.PLATE_IMAGE_BASE ?? null)
      return url ? [[executionPlate.id, url]] : []
    }))
    run.progress.workflowUrl = recordedWorkflowUrl(attempt.workflowId, attempt.workflowUrl)
  }
  const summaries = result.value.map(run => ({ ...run,
    fingerprint: undefined,
    attempts: run.attempts.map(attempt => ({ ...Object.fromEntries(Object.entries(attempt).filter(([key]) => !['projection', 'steps', 'completedJobIds', 'jobIds', 'choices'].includes(key))),
      stepCount: attempt.steps.length, completedCount: attempt.completedJobIds.length })),
    jobs: run.jobs.filter(job => job.state === 'claimed').map(job => Object.fromEntries(Object.entries(job).filter(([key]) => key !== 'inputPlate' && key !== 'result'))),
  }))
  const entries = Object.values(selected?.attempts.at(-1)?.projection?.plates ?? {})
  const detail = selected ? {
    ...selected,
    plates: entries.map(entry => runPlateDetail(entry.batchInput)),
    cards: entries.map((entry, index) => plateCard(entry.executionPlate, index, plate => plateImageUrl(plate, process.env.PLATE_IMAGE_BASE ?? null))),
    attempts: selected.attempts.map((attempt, index) => index === selected.attempts.length - 1 ? attempt :
      Object.fromEntries(Object.entries(attempt).filter(([key]) => key !== 'projection'))),
  } : undefined
  const orphanJobs = await listLocalOrphanJobs(dependencies, auth.actor)
  const capabilities = { ...worker, previewOnly: { available: true } }
  return json({ runs: summaries, orphanJobs, capabilities, observedAt: dependencies.now(), ...(detail ? { selected: detail } : {}) })
}

export async function POST(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const input = parseEnqueue(await readJson(request))
  if (!input) return badRequest()
  const result = await enqueueSelection(jobsDeps(), auth.actor, input)
  if (!result.ok) return queueResponse(result)
  const run = result.value[0]
  try { await startQueueWorkflow(run) } catch { return json({ error: 'start_failed', runId: run.id }, 503) }
  return queueResponse({ ok: true, value: run }, 202)
}
