import { minimumPlateTagCount } from '../catalog/plate-checks'
import { defaultImageEnhancement, enhancementOperations } from './image-enhancement'
import type { Plate } from '../catalog/types'
import type { PipelineOptions } from './pipeline-options'
import type { LocalRunStage, ResourceClass } from './queue-types'
import { enrichmentTargets } from '../research/enrichment'

export const canonicalStages: readonly LocalRunStage[] = ['find-image', 'enhance-image', 'research', 'wiki-link', 'colors', 'describe', 'story', 'tag', 'group']
export const stageDependencies: Record<LocalRunStage, readonly LocalRunStage[]> = {
  'find-image': [], 'enhance-image': ['find-image'], research: [], 'wiki-link': ['research'], colors: ['find-image'], describe: ['research', 'wiki-link'], story: ['research', 'wiki-link', 'describe'], tag: ['find-image', 'colors'], group: ['colors', 'tag'],
}
export type RunStep = {
  index: number; plateId: string; stage: LocalRunStage; resourceClass: ResourceClass
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped'
  completedJobId?: string
  startedAt?: number
  endedAt?: number
  reason?: string
}

const plateFailureReasons = new Set(['stage_failed', 'no_sources', 'no_supported_fields', 'missing_image', 'missing_wiki_link', 'missing_description'])

export function isPlateFailure(reason: string | undefined): boolean {
  return reason !== undefined && plateFailureReasons.has(reason)
}

/**
 * Order selected stages by their dependencies while keeping the plan limited to selected
 * stages.
 */
export function orderedPipelineStages(stages: readonly LocalRunStage[]): LocalRunStage[] {
  const result: LocalRunStage[] = []
  /**
   * Visit selected prerequisite stages before adding the requesting stage to the plan.
   */
  const visit = (stage: LocalRunStage) => {
    if (result.includes(stage)) return
    for (const dependency of stageDependencies[stage]) if (stages.includes(dependency)) visit(dependency)
    result.push(stage)
  }
  for (const stage of canonicalStages) if (stages.includes(stage)) visit(stage)
  return result
}

type PlanningPlate = Pick<Plate, 'id' | 'tags'> & Partial<Plate> & { hasStory?: boolean }

/**
 * Identify plans that need a model, including grouping when its vision tiebreaker is
 * enabled.
 */
export function pipelineNeedsModel(steps: readonly Pick<RunStep, 'stage'>[], options: PipelineOptions): boolean {
  return steps.some(step => ['tag', 'colors', 'describe', 'story'].includes(step.stage) || step.stage === 'group' && options.group?.visionTiebreak === true)
}

/**
 * Expand selected stages to indexed per-plate work, applying enrichment eligibility and
 * resource requirements.
 */
export function planPipeline(plates: PlanningPlate[], stages: LocalRunStage[], options: PipelineOptions): RunStep[] {
  const selected = orderedPipelineStages(stages)
  const steps: Omit<RunStep, 'index'>[] = []
  for (const plate of plates) for (const stage of selected) {
    if (stage === 'group' || stage === 'research' && !enrichmentTargets(plate, options.research?.policy ?? 'fill-missing').length || stage === 'find-image' && options['find-image']?.onlyMissingImage && (plate.image || plate.imageUrl) ||
      stage === 'enhance-image' && !enhancementOperations.some(key => (options['enhance-image'] ?? defaultImageEnhancement)[key]) ||
      stage === 'tag' && options.tag?.onlyUnderTagged && plate.tags.length >= minimumPlateTagCount ||
      stage === 'story' && options.story?.redoExisting === false && (plate.hasStory ?? !!plate.funFacts?.length)) continue
    steps.push({ plateId: plate.id, stage, resourceClass: ['tag', 'describe', 'story', 'colors'].includes(stage) ? 'gpu' : 'io' })
  }
  if (selected.includes('group') && plates.length) steps.push({ plateId: plates[0].id, stage: 'group', resourceClass: 'gpu' })
  return steps.map((step, index) => ({ ...step, index }))
}
