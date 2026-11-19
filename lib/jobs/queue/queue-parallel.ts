import { taggingModel } from '../../tagging/models'
import { gatewayModelId } from '../../models/selection'
import type { LocalRunStage, RunAttempt } from './queue-types'

export const gatewayTagConcurrency = 6

export function parallelGatewayTagPlan(
  stages: readonly LocalRunStage[],
  modelId: string | undefined,
  stepCount: number
) {
  return (
    stepCount > 1 &&
    stages.length === 1 &&
    stages[0] === 'tag' &&
    (taggingModel(modelId)?.runsOn === 'gateway' ||
      (modelId !== undefined && gatewayModelId.test(modelId)))
  )
}

export function inQueueWindow(attempt: RunAttempt, index: number | undefined) {
  if (index === undefined) return false
  if (index === attempt.cursor) return true
  if (
    !attempt.parallelTag ||
    index <= attempt.cursor ||
    index >= attempt.cursor + gatewayTagConcurrency
  )
    return false
  const step = attempt.steps[index]
  return (
    step?.stage === 'tag' &&
    step.status !== 'completed' &&
    step.status !== 'failed' &&
    step.status !== 'cancelled' &&
    step.status !== 'skipped'
  )
}

export function parallelTagIndices(attempt: RunAttempt) {
  const end = Math.min(
    attempt.steps.length,
    attempt.cursor + gatewayTagConcurrency
  )
  return attempt.steps
    .slice(attempt.cursor, end)
    .filter((step) => inQueueWindow(attempt, step.index))
    .map((step) => step.index)
}
