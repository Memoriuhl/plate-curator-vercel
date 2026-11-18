import type { Actor } from '../review/types'
import type { JobsDeps } from './types'
import type { PipelineProgress, StepProgress } from './run-progress'
import type { LocalRunStage, RunStatus } from './queue-types'
import { recordedWorkflowUrl } from './workflow-visibility'
import { runPlateDetail, type RunPlateDetail } from './run-plates'

export type GatewayRun = {
  id: string; batchId: string; requestedBy: string; plateIds: string[]; modelId?: string
  createdAt: number; status: RunStatus; progress: PipelineProgress
  stages?: LocalRunStage[]
  plates?: RunPlateDetail[]
  results: { jobId: string; plateId: string; plateName: string; inputHash: string; suggestions: string[] }[]
}

export async function listGatewayRuns(d: JobsDeps, actor: Actor, unscoped?: JobsDeps): Promise<GatewayRun[]> {
  const groups = await Promise.all([gatewayRunsInStore(d, actor), ...(unscoped ? [gatewayRunsInStore(unscoped, actor)] : [])])
  const runs = groups.flat().sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  return [...runs.filter(run => ['running', 'queued'].includes(run.status)), ...runs.filter(run => !['running', 'queued'].includes(run.status)).slice(0, 50)]
}

function gatewayRunsInStore(d: JobsDeps, actor: Actor): Promise<GatewayRun[]> {
  return d.store.transaction(async tx => {
    const jobs = (await tx.list()).filter(job => job.route === 'hosted' && job.env === d.store.env && job.localScope === d.localScope && (actor.role === 'owner' || job.requestedBy === actor.uid))
    const groups = new Map<string, typeof jobs>()
    for (const job of jobs) {
      const id = job.queueRunId ?? job.workflowId ?? job.id
      groups.set(id, [...(groups.get(id) ?? []), job])
    }
    return Promise.all([...groups].map(async ([id, jobs]): Promise<GatewayRun> => {
      const recorded = jobs.reduce<(typeof jobs)[number] | undefined>((latest, job) =>
        (job.workflowId || job.workflowUrl) && (!latest || (job.queueAttempt ?? 0) > (latest.queueAttempt ?? 0)) ? job : latest, undefined)
      const linkedRun = !recorded && jobs[0].queueRunId ? await tx.getRun(id) : null
      const workflow = recorded ?? linkedRun?.attempts.at(-1)
      const workflowUrl = recordedWorkflowUrl(workflow?.workflowId, workflow?.workflowUrl)
      const steps = jobs.map((job, index): StepProgress => ({ index, plateId: job.plateId, plateName: job.inputPlate?.displayName ?? job.plateId, stage: job.stage === 'research' ? 'research' : 'tag',
        status: job.state === 'claimed' ? 'running' : job.state === 'expired' ? 'failed' : job.state,
        ...(job.result ? { durationMs: job.result.durationMs } : {}), ...(job.failure ? { reason: job.failure } : {}) }))
      const active = steps.some(step => ['queued', 'running'].includes(step.status))
      const status = active ? steps.some(step => step.status === 'running') ? 'running' : 'queued'
        : steps.some(step => step.status === 'failed') ? 'failed' : steps.some(step => step.status === 'cancelled') ? 'cancelled' : 'completed'
      const ends = jobs.flatMap(job => { const end = job.completedAt ?? job.endedAt ?? job.expiredAt; return end === undefined ? [] : [end] })
      return { id, batchId: jobs[0].batchId, requestedBy: jobs[0].requestedBy, plateIds: [...new Set(jobs.map(job => job.plateId))], modelId: jobs[0].modelId,
        createdAt: Math.min(...jobs.map(job => job.createdAt)), status,
        stages: [...new Set(steps.map(step => step.stage))],
        progress: { steps, workerIds: [], ...(ends.length === jobs.length && !active ? { endedAt: Math.max(...ends) } : {}), workflowUrl, ...(!workflowUrl ? { gatewayUrl: 'https://vercel.com/memoriuhl/~/ai-gateway/logs' } : {}) },
        plates: jobs.flatMap(job => job.inputPlate ? [runPlateDetail(job.inputPlate)] : []),
        results: jobs.filter(job => job.state === 'completed').map(job => ({ jobId: job.id, plateId: job.plateId, plateName: job.inputPlate?.displayName ?? job.plateId, inputHash: job.inputHash, suggestions: job.result?.suggestions ?? [] })) }
    }))
  })
}
