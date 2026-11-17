import type { PipelineStage } from '@/lib/jobs/types'
import type { PipelineOptions } from '@/lib/jobs/pipeline-options'

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
  disabledReason?: string
  options: readonly StageOption[]
}
export type PipelineSelection = { selectedStages: (PipelineStage | 'tag')[]; options: PipelineOptions; previewOnly: boolean }

export const pipelineStages: readonly StageDefinition[] = [
  { id: 'find-image', label: 'Find image', description: 'Search for a clean plate photo', duration: '0:20', jobKind: 'find-image', localEnabled: false,
    disabledReason: 'Needs an image-search job and draft result', options: [{ id: 'onlyMissingImage', label: 'Only plates missing an image', kind: 'boolean', default: true }] },
  { id: 'wiki-link', label: 'Wiki link', description: 'Match a Wikipedia or DMV page', duration: '0:15', jobKind: 'wiki-link', localEnabled: false,
    disabledReason: 'Needs a reference-search job and draft result', options: [] },
  { id: 'colors', label: 'Colors', description: 'Background and text colours', duration: '0:05', jobKind: 'colors', localEnabled: false,
    disabledReason: 'Needs a color job and editable color fields', options: [] },
  { id: 'describe', label: 'Describe', description: 'Write the description from the source', duration: '1:30', jobKind: 'describe', localEnabled: true, options: [] },
  { id: 'story', label: 'Story', description: 'First issued, fun facts and read-more links', duration: '2:10', jobKind: 'story', localEnabled: true,
    options: [{ id: 'redoExisting', label: 'Redo plates that already have a story', kind: 'boolean', default: false }] },
  { id: 'tag', label: 'Tag', description: 'Suggest tags with the selected model', duration: '0:40', jobKind: 'tag', localEnabled: true,
    options: [{ id: 'onlyUnderTagged', label: 'Only under-tagged plates', kind: 'boolean', default: false }] },
  { id: 'group', label: 'Group', description: 'Propose template families', duration: '1:00', jobKind: 'group', localEnabled: false,
    disabledReason: 'Needs a grouping job and family draft results', options: [
      { id: 'colorSignal', label: 'Use colour signal', kind: 'boolean', default: true },
      { id: 'backgroundMask', label: 'Background mask', kind: 'boolean', default: false, disabledReason: 'Needs the local background-mask runtime' },
      { id: 'visionTiebreak', label: 'Vision tiebreak', kind: 'boolean', default: false },
      { id: 'method', label: 'Method', kind: 'select', default: 'vision', choices: [
        { value: 'vision', label: 'Vision' }, { value: 'embeddings', label: 'Embeddings', disabledReason: 'Needs the local embeddings runtime' },
      ] },
    ] },
  { id: 'order', label: 'Order', description: 'No automatic step yet', duration: '—', jobKind: null, localEnabled: false,
    disabledReason: 'Order is manual: drag families to reorder', options: [] },
]

export function stageAvailability(stage: StageDefinition, local: boolean) {
  return stage.id === 'tag' || local && stage.localEnabled ? undefined : local ? stage.disabledReason : 'Coming soon'
}
