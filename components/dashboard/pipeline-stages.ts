import type { PipelineStage } from '@/lib/jobs/types'
import type { PipelineOptions } from '@/lib/jobs/pipeline-options'
import type { readLocalWorkerCapabilities } from '@/lib/jobs/capabilities'
export { stageDependencies } from '@/lib/jobs/pipeline-plan'

export type StageOption = {
  id: string
  label: string
  kind: 'boolean' | 'select'
  default: boolean | string
  choices?: readonly { value: string; label: string; disabledReason?: string }[]
  disabledReason?: string
}
export type StageDefinition = {
  id: PipelineStage | 'tag'
  label: string
  description: string
  duration: string
  jobKind: PipelineStage | 'tag' | null
  localEnabled: boolean
  legacyResearch?: true
  disabledReason?: string
  options: readonly StageOption[]
}
export type PipelineSelection = { selectedStages: (PipelineStage | 'tag')[]; options: PipelineOptions; previewOnly: boolean }

export const pipelineStages: readonly StageDefinition[] = [
  { id: 'research', label: 'Research / enrich', description: 'Wikipedia link, description and sourced Story in one run', duration: '1:30', jobKind: 'research', localEnabled: true, options: [
    { id: 'policy', label: 'Research edits', kind: 'select', default: 'fill-missing', choices: [{ value: 'fill-missing', label: 'Fill missing' }, { value: 'replace', label: 'Replace existing' }] },
  ] },
  { id: 'find-image', label: 'Find image', description: 'Search for a clean plate photo', duration: '0:20', jobKind: 'find-image', localEnabled: true, options: [{ id: 'onlyMissingImage', label: 'Only plates missing an image', kind: 'boolean', default: false }] },
  { id: 'wiki-link', label: 'Wiki link', description: 'Match a Wikipedia or DMV page', duration: '0:15', jobKind: 'wiki-link', localEnabled: true, legacyResearch: true, options: [] },
  { id: 'colors', label: 'Colors', description: 'Background and text colours', duration: '0:05', jobKind: 'colors', localEnabled: true, options: [] },
  { id: 'describe', label: 'Describe', description: 'Write the description from the source', duration: '1:30', jobKind: 'describe', localEnabled: true, legacyResearch: true, options: [] },
  { id: 'story', label: 'Story', description: 'First issued, fun facts and read-more links', duration: '2:10', jobKind: 'story', localEnabled: true, legacyResearch: true,
    options: [{ id: 'redoExisting', label: 'Redo plates that already have a story', kind: 'boolean', default: false }] },
  { id: 'tag', label: 'Tag', description: 'Suggest tags with the selected model', duration: '0:40', jobKind: 'tag', localEnabled: true,
    options: [{ id: 'onlyUnderTagged', label: 'Only under-tagged plates', kind: 'boolean', default: false }] },
  { id: 'group', label: 'Group', description: 'Propose template families', duration: '1:00', jobKind: 'group', localEnabled: true, options: [
      { id: 'colorSignal', label: 'Use colour signal', kind: 'boolean', default: true },
      { id: 'backgroundMask', label: 'Background mask', kind: 'boolean', default: false },
      { id: 'visionTiebreak', label: 'Vision tiebreak', kind: 'boolean', default: false },
      { id: 'method', label: 'Method', kind: 'select', default: 'embeddings', choices: [
        { value: 'embeddings', label: 'Embeddings' },
      ] },
    ] },
  { id: 'order', label: 'Order', description: 'No automatic step yet', duration: '—', jobKind: null, localEnabled: false,
    disabledReason: 'Order is manual: drag families to reorder', options: [] },
]

export const newRunStages = pipelineStages.filter(stage => !stage.legacyResearch)

export type PipelineCapabilities = Awaited<ReturnType<typeof readLocalWorkerCapabilities>>

export function stageAvailability(stage: StageDefinition, local: boolean, capabilities?: PipelineCapabilities) {
  if (local && (stage.id === 'group' || stage.id === 'find-image')) {
    const capability = capabilities?.[stage.id]
    if (!capability?.available) return capability && 'reason' in capability ? capability.reason : 'Local worker not reporting'
  }
  return stage.id === 'tag' || local && stage.localEnabled ? undefined : local ? stage.disabledReason : 'Coming soon'
}
