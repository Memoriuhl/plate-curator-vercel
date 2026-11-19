import { pipelineNeedsModel } from '@/lib/jobs/pipeline/pipeline-plan'
import type { QueueRunSummary } from '@/lib/jobs/queue/queue-types'
import { researchModel } from '@/lib/research/models/models'
import { taggingModel } from '@/lib/tagging/models'

export const machineLabels = {
  all: 'All Machines',
  local: 'Local PC',
  gateway: 'Vercel Gateway',
} as const

export type PipelineMachineFilter = keyof typeof machineLabels
type PipelineMachine = Exclude<PipelineMachineFilter, 'all'>
export type RunExecution = { machine: PipelineMachine; models: string[] }

export function runModelLabel(id: string | undefined) {
  return taggingModel(id)?.label ?? researchModel(id)?.label ?? id
}

export function queueRunExecution(run: QueueRunSummary): RunExecution[] {
  const stages = run.progress?.steps.length
    ? run.progress.steps.map((step) => step.stage)
    : run.stages
  const byMachine = new Map<PipelineMachine, Set<string>>()
  for (const stage of new Set(stages)) {
    let machine: PipelineMachine = 'local'
    let label: string | undefined
    if (stage === 'research' && run.researchModel) {
      machine = run.researchModel.executor === 'eve' ? 'gateway' : 'local'
      label =
        researchModel(run.researchModel.id)?.label ?? run.researchModel.model
    } else if (stage === 'tag') {
      const id = run.tagModelId ?? run.modelId
      if (
        run.modelBindings?.tag ||
        taggingModel(id)?.runsOn === 'gateway' ||
        id?.startsWith('gateway-')
      )
        machine = 'gateway'
      label = runModelLabel(id)
    } else if (pipelineNeedsModel([{ stage }], run.options)) {
      label = runModelLabel(run.modelId)
    }
    const models = byMachine.get(machine) ?? new Set<string>()
    if (label) models.add(label)
    byMachine.set(machine, models)
  }
  return byMachine.size
    ? [...byMachine].map(([machine, models]) => ({
        machine,
        models: [...models],
      }))
    : [{ machine: 'local', models: [] }]
}
