import { runPlateDetail } from '../../../../lib/jobs/run-plates'
import { enqueueRun, listRuns, parseEnqueue } from '../../../../lib/jobs/queue'
import { currentActor, jobsDeps } from '../../../../lib/server/context'
import { badRequest, json, readJson } from '../../../../lib/server/respond'
import { queueResponse, reconcileQueueWorkflow, startQueueWorkflow, wakeLocalJob } from '../../../../lib/server/local-queue'
import { listLocalOrphanJobs } from '../../../../lib/jobs/queue-failure'
import { readLocalWorkerCapabilities } from '../../../../lib/jobs/capabilities'
import { queueProgress } from '../../../../lib/jobs/run-progress'
import { workflowVisibilityUrl } from '../../../../lib/jobs/workflow-visibility'

export async function GET(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  let result = await listRuns(jobsDeps(), auth.actor)
  if (!result.ok) return queueResponse(result)
  let reconciled = false
  for (const run of result.value) {
    if (await reconcileQueueWorkflow(run).catch(() => false)) reconciled = true
    await startQueueWorkflow(run).catch(() => undefined)
    const attempt = run.attempts.at(-1)!
    if (['queued', 'running'].includes(run.status)) {
      const current = run.jobs.find(job => job.queueAttempt === attempt.number && job.queueStep === attempt.cursor)
      if (current && current.state !== 'queued' && (current.state !== 'claimed' || run.waitReason === 'resource')) await wakeLocalJob(current)
    }
  }
  if (reconciled) { result = await listRuns(jobsDeps(), auth.actor); if (!result.ok) return queueResponse(result) }
  const selectedId = new URL(request.url).searchParams.get('detail')
  const selected = selectedId ? result.value.find(run => run.id === selectedId) : result.value.find(run => run.status === 'running') ?? result.value[0]
  for (const run of result.value) {
    run.progress = queueProgress(run)
    const attempt = run.attempts.at(-1)!
    run.progress.workflowUrl = attempt.workflowUrl === undefined ? workflowVisibilityUrl(attempt.workflowId, process.env.VERCEL_ENV) : attempt.workflowUrl
  }
  const summaries = result.value.map(run => ({ ...run,
    fingerprint: undefined,
    attempts: run.attempts.map(attempt => ({ ...Object.fromEntries(Object.entries(attempt).filter(([key]) => !['projection', 'steps', 'completedJobIds', 'jobIds', 'choices'].includes(key))),
      stepCount: attempt.steps.length, completedCount: attempt.completedJobIds.length })),
    jobs: run.jobs.filter(job => job.state === 'claimed').map(job => Object.fromEntries(Object.entries(job).filter(([key]) => key !== 'inputPlate' && key !== 'result'))),
  }))
  const detail = selected ? { ...selected, plates: Object.values(selected.attempts.at(-1)?.projection?.plates ?? {}).map(entry => runPlateDetail(entry.batchInput)), attempts: selected.attempts.map((attempt, index) => index === selected.attempts.length - 1 ? attempt :
    Object.fromEntries(Object.entries(attempt).filter(([key]) => key !== 'projection'))) } : undefined
  const orphanJobs = await listLocalOrphanJobs(jobsDeps(), auth.actor)
  const capabilities = { ...await readLocalWorkerCapabilities(jobsDeps()), previewOnly: { available: true } }
  return json({ runs: summaries, orphanJobs, capabilities, observedAt: jobsDeps().now(), ...(detail ? { selected: detail } : {}) })
}

export async function POST(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const input = parseEnqueue(await readJson(request))
  if (!input) return badRequest()
  const result = await enqueueRun(jobsDeps(), auth.actor, input)
  if (result.ok) {
    try { await startQueueWorkflow(result.value) } catch { return json({ error: 'start_failed', runId: result.value.id }, 503) }
  }
  return queueResponse(result, 202)
}
