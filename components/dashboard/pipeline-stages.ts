import type { IconType } from 'react-icons'
import {
  IoAddCircleOutline, IoBookOutline, IoCheckmarkCircleOutline, IoColorPaletteOutline, IoDocumentTextOutline,
  IoGitMergeOutline, IoGridOutline, IoImagesOutline, IoLinkOutline, IoListOutline, IoPencilOutline,
  IoPricetagsOutline, IoScanOutline, IoSearchOutline, IoSparklesOutline, IoOptionsOutline, IoDownloadOutline,
} from 'react-icons/io5'
import type { InlineSelectChoice } from '@/components/ui/inline-select'
import { minimumPlateTagCount } from '@/lib/catalog/plate-checks'
import type { PipelineStage } from '@/lib/jobs/types'
import { defaultImageEnhancement } from '@/lib/jobs/image-enhancement'
import type { PipelineOptions } from '@/lib/jobs/pipeline-options'
import type { readLocalWorkerCapabilities } from '@/lib/jobs/capabilities'
export { stageDependencies } from '@/lib/jobs/pipeline-plan'

export type StageOption = {
  id: string
  label: string
  kind: 'boolean' | 'select'
  default: boolean | string
  choices?: readonly InlineSelectChoice[]
  disabledReason?: string
}
export type StageDefinition = {
  id: PipelineStage | 'tag'
  label: string
  description: string
  icon: IconType
  flow?: readonly { label: string; icon: IconType }[]
  duration: string
  jobKind: PipelineStage | 'tag' | null
  localEnabled: boolean
  legacyResearch?: true
  disabledReason?: string
  options: readonly StageOption[]
}
export type PipelineSelection = { selectedStages: (PipelineStage | 'tag')[]; options: PipelineOptions; previewOnly: boolean }

export const onlyUnderTaggedLabel = `Only under-tagged plates (fewer than ${minimumPlateTagCount} tags)`

export const pipelineStages: readonly StageDefinition[] = [
  { id: 'research', icon: IoSearchOutline, label: 'Research / enrich', description: 'Wikipedia link, description and sourced Story in one run', duration: '1:30', jobKind: 'research', localEnabled: true,
    flow: [{ label: 'Find sources', icon: IoLinkOutline }, { label: 'Draft description & story', icon: IoDocumentTextOutline }],
    options: [
    { id: 'policy', label: 'Research edits', kind: 'select', default: 'fill-missing', choices: [{ value: 'fill-missing', label: 'Fill missing', icon: IoAddCircleOutline }, { value: 'replace', label: 'Replace existing', icon: IoPencilOutline }] },
    { id: 'reuseSavedSources', label: 'Reuse saved sources', kind: 'boolean', default: false },
  ] },
  { id: 'find-image', icon: IoImagesOutline, label: 'Find image', description: 'Search for a clean plate photo', duration: '0:20', jobKind: 'find-image', localEnabled: true,
    flow: [{ label: 'Search Commons', icon: IoSearchOutline }, { label: 'Check images', icon: IoCheckmarkCircleOutline }, { label: 'Offer candidates', icon: IoImagesOutline }],
    options: [{ id: 'onlyMissingImage', label: 'Only plates missing an image', kind: 'boolean', default: false }] },
  { id: 'enhance-image', icon: IoSparklesOutline, label: 'Enhance image', description: 'Create a downloadable WebP from the current plate image',
    duration: '0:05', jobKind: 'enhance-image', localEnabled: true,
    flow: [{ label: 'Apply edits', icon: IoOptionsOutline }, { label: 'Export WebP', icon: IoDownloadOutline }],
    options: [
      { id: 'upscale', label: 'Upscale', kind: 'boolean', default: defaultImageEnhancement.upscale },
      { id: 'crop', label: 'Crop margins', kind: 'boolean', default: defaultImageEnhancement.crop },
      { id: 'roundCorners', label: 'Round corners', kind: 'boolean', default: defaultImageEnhancement.roundCorners },
    ] },
  { id: 'wiki-link', icon: IoLinkOutline, label: 'Wiki link', description: 'Match a Wikipedia or DMV page', duration: '0:15', jobKind: 'wiki-link', localEnabled: true, legacyResearch: true, options: [] },
  { id: 'colors', icon: IoColorPaletteOutline, label: 'Colors', description: 'Background and text colours', duration: '0:05', jobKind: 'colors', localEnabled: true, options: [] },
  { id: 'describe', icon: IoDocumentTextOutline, label: 'Describe', description: 'Write the description from the source', duration: '1:30', jobKind: 'describe', localEnabled: true, legacyResearch: true, options: [] },
  { id: 'story', icon: IoBookOutline, label: 'Story', description: 'First issued, fun facts and read-more links', duration: '2:10', jobKind: 'story', localEnabled: true, legacyResearch: true,
    options: [{ id: 'redoExisting', label: 'Redo plates that already have a story', kind: 'boolean', default: false }] },
  { id: 'tag', icon: IoPricetagsOutline, label: 'Tag', description: 'Suggest tags with the selected model', duration: '0:40', jobKind: 'tag', localEnabled: true,
    options: [{ id: 'onlyUnderTagged', label: onlyUnderTaggedLabel, kind: 'boolean', default: false }] },
  { id: 'group', icon: IoGridOutline, label: 'Group', description: 'Propose template families', duration: '1:00', jobKind: 'group', localEnabled: true,
    flow: [{ label: 'Embed images', icon: IoScanOutline }, { label: 'Compare', icon: IoGitMergeOutline }, { label: 'Propose families', icon: IoGridOutline }],
    options: [
      { id: 'method', label: 'Method', kind: 'select', default: 'embeddings', choices: [
        { value: 'embeddings', label: 'Embeddings', icon: IoScanOutline },
      ] },
      { id: 'colorSignal', label: 'Use colour signal', kind: 'boolean', default: true },
      { id: 'backgroundMask', label: 'Background mask', kind: 'boolean', default: false },
      { id: 'visionTiebreak', label: 'Vision tiebreak', kind: 'boolean', default: false },
    ] },
  { id: 'order', icon: IoListOutline, label: 'Order', description: 'No automatic step yet', duration: '—', jobKind: null, localEnabled: false,
    disabledReason: 'Order is manual: drag families to reorder', options: [] },
]

export const newRunStages = pipelineStages.filter(
  (stage): stage is StageDefinition & { id: Exclude<StageDefinition['id'], 'order' | 'colors'> } =>
    !stage.legacyResearch && stage.id !== 'order' && stage.id !== 'colors',
)

export type PipelineCapabilities = Awaited<ReturnType<typeof readLocalWorkerCapabilities>>

export function stageAvailability(stage: StageDefinition, local: boolean, capabilities?: PipelineCapabilities) {
  if (local && (stage.id === 'group' || stage.id === 'find-image' || stage.id === 'enhance-image')) {
    if (!capabilities) return 'Local worker not reporting'
    if (stage.id === 'group') {
      if (!capabilities.group.available) return capabilities.group.reason ?? 'Grouping is unavailable'
      if (!capabilities.embeddings.available) return capabilities.embeddings.reason ?? 'No grouping methods are available'
    } else if (stage.id === 'enhance-image') {
      if (!capabilities[stage.id].available) return capabilities[stage.id].reason ?? 'Image enhancement is unavailable'
    } else if (!capabilities['find-image'].available) {
      return 'reason' in capabilities['find-image'] ? capabilities['find-image'].reason : 'Image search is unavailable'
    }
  }
  return stage.id === 'tag' || local && stage.localEnabled ? undefined : local ? stage.disabledReason : 'Coming soon'
}
