import type { Plate } from '../catalog/types'
import type { PipelineOptions } from './pipeline-options'
import type { LocalRunStage, ResourceClass } from './queue-types'

export const canonicalStages: readonly LocalRunStage[] = ['find-image', 'wiki-link', 'colors', 'describe', 'story', 'tag', 'group']
export const stageDependencies: Record<LocalRunStage, readonly LocalRunStage[]> = {
  'find-image': [], 'wiki-link': [], colors: ['find-image'], describe: ['wiki-link'], story: ['wiki-link'], tag: ['find-image', 'colors'], group: ['colors', 'tag'],
}
export type RunStep = { index: number; plateId: string; stage: LocalRunStage; resourceClass: ResourceClass }

export function orderedPipelineStages(stages: readonly LocalRunStage[]): LocalRunStage[] {
  const result: LocalRunStage[] = []
  const visit = (stage: LocalRunStage) => {
    if (result.includes(stage)) return
    for (const dependency of stageDependencies[stage]) if (stages.includes(dependency)) visit(dependency)
    result.push(stage)
  }
  for (const stage of canonicalStages) if (stages.includes(stage)) visit(stage)
  return result
}

export function planPipeline(plates: Plate[], stages: LocalRunStage[], options: PipelineOptions): RunStep[] {
  const selected = orderedPipelineStages(stages)
  const steps: Omit<RunStep, 'index'>[] = []
  for (const plate of plates) for (const stage of selected) {
    if (stage === 'group' || stage === 'find-image' && options['find-image']?.onlyMissingImage && (plate.image || plate.imageUrl) ||
      stage === 'tag' && options.tag?.onlyUnderTagged && plate.tags.length >= 3 ||
      stage === 'story' && options.story?.redoExisting === false && plate.funFacts?.length) continue
    steps.push({ plateId: plate.id, stage, resourceClass: ['tag', 'describe', 'story', 'colors'].includes(stage) ? 'gpu' : 'io' })
  }
  if (selected.includes('group') && plates.length) steps.push({ plateId: plates[0].id, stage: 'group', resourceClass: 'gpu' })
  return steps.map((step, index) => ({ ...step, index }))
}
