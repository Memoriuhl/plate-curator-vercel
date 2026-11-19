import type { IconType } from 'react-icons'
import {
  IoAddCircleOutline,
  IoBookOutline,
  IoCheckmarkCircleOutline,
  IoColorPaletteOutline,
  IoDocumentTextOutline,
  IoGitMergeOutline,
  IoGridOutline,
  IoImagesOutline,
  IoLinkOutline,
  IoListOutline,
  IoPencilOutline,
  IoPricetagsOutline,
  IoScanOutline,
  IoSearchOutline,
  IoSparklesOutline,
  IoOptionsOutline,
  IoDownloadOutline,
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
/** How a stage's result reaches the plate: saved on its own or only after a person acts. */
export type ResultRule = {
  mode: 'automatic' | 'apply' | 'choose' | 'verify'
  label: string
}
const automatic = (label = 'Saved automatically'): ResultRule => ({
  mode: 'automatic',
  label,
})
export type StageDefinition = {
  id: PipelineStage | 'tag'
  label: string
  description: string
  icon: IconType
  flow?: readonly { label: string; icon: IconType }[]
  jobKind: PipelineStage | 'tag' | null
  localEnabled: boolean
  legacyResearch?: true
  disabledReason?: string
  /** Absent for stages that produce no result, such as manual Order. */
  resultRule?: ResultRule
  options: readonly StageOption[]
}
export type PipelineSelection = {
  selectedStages: (PipelineStage | 'tag')[]
  options: PipelineOptions
  previewOnly: boolean
}

export const onlyUnderTaggedLabel = `Only under-tagged plates (fewer than ${minimumPlateTagCount} tags)`

export const pipelineStages: readonly StageDefinition[] = [
  {
    id: 'research',
    resultRule: automatic(),
    icon: IoSearchOutline,
    label: 'Research / enrich',
    description: 'Wikipedia link, description and sourced Story in one run',
    jobKind: 'research',
    localEnabled: true,
    flow: [
      { label: 'Find sources', icon: IoLinkOutline },
      { label: 'Draft description & story', icon: IoDocumentTextOutline },
      { label: 'Validate result', icon: IoCheckmarkCircleOutline },
    ],
    options: [
      {
        id: 'policy',
        label: 'Research edits',
        kind: 'select',
        default: 'fill-missing',
        choices: [
          {
            value: 'fill-missing',
            label: 'Fill missing',
            icon: IoAddCircleOutline,
          },
          {
            value: 'replace',
            label: 'Replace existing',
            icon: IoPencilOutline,
          },
        ],
      },
      {
        id: 'reuseSavedSources',
        label: 'Use saved sources only',
        kind: 'boolean',
        default: false,
      },
    ],
  },
  {
    id: 'find-image',
    resultRule: {
      mode: 'choose',
      label: 'Waits for you to choose a candidate',
    },
    icon: IoImagesOutline,
    label: 'Find image',
    description: 'Search for a clean plate photo',
    jobKind: 'find-image',
    localEnabled: false,
    disabledReason:
      'Work in progress: candidates will wait for your pick in Review',
    flow: [
      { label: 'Search Commons', icon: IoSearchOutline },
      { label: 'Check images', icon: IoCheckmarkCircleOutline },
      { label: 'Offer candidates', icon: IoImagesOutline },
    ],
    options: [
      {
        id: 'onlyMissingImage',
        label: 'Only plates missing an image',
        kind: 'boolean',
        default: false,
      },
    ],
  },
  {
    id: 'enhance-image',
    resultRule: { mode: 'apply', label: 'Waits until you click Apply' },
    icon: IoSparklesOutline,
    label: 'Enhance image',
    description: 'Create a downloadable WebP from the current plate image',
    jobKind: 'enhance-image',
    localEnabled: true,
    flow: [
      { label: 'Apply edits', icon: IoOptionsOutline },
      { label: 'Export WebP', icon: IoDownloadOutline },
    ],
    options: [
      {
        id: 'upscale',
        label: 'Upscale',
        kind: 'boolean',
        default: defaultImageEnhancement.upscale,
      },
      {
        id: 'crop',
        label: 'Crop margins',
        kind: 'boolean',
        default: defaultImageEnhancement.crop,
      },
      {
        id: 'roundCorners',
        label: 'Round corners',
        kind: 'boolean',
        default: defaultImageEnhancement.roundCorners,
      },
    ],
  },
  {
    id: 'wiki-link',
    resultRule: automatic(),
    icon: IoLinkOutline,
    label: 'Wiki link',
    description: 'Match a Wikipedia or DMV page',
    jobKind: 'wiki-link',
    localEnabled: true,
    legacyResearch: true,
    options: [],
  },
  {
    id: 'colors',
    resultRule: automatic(),
    icon: IoColorPaletteOutline,
    label: 'Colors',
    description: 'Background and text colours',
    jobKind: 'colors',
    localEnabled: true,
    options: [],
  },
  {
    id: 'describe',
    resultRule: automatic(),
    icon: IoDocumentTextOutline,
    label: 'Describe',
    description: 'Write the description from the source',
    jobKind: 'describe',
    localEnabled: true,
    legacyResearch: true,
    options: [],
  },
  {
    id: 'story',
    resultRule: automatic(),
    icon: IoBookOutline,
    label: 'Story',
    description: 'First issued, fun facts and read-more links',
    jobKind: 'story',
    localEnabled: true,
    legacyResearch: true,
    options: [
      {
        id: 'redoExisting',
        label: 'Redo plates that already have a story',
        kind: 'boolean',
        default: false,
      },
    ],
  },
  {
    id: 'tag',
    resultRule: automatic('Saved automatically; Review is optional'),
    icon: IoPricetagsOutline,
    label: 'Tag',
    description: 'Suggest tags with the selected model',
    jobKind: 'tag',
    localEnabled: true,
    options: [
      {
        id: 'onlyUnderTagged',
        label: onlyUnderTaggedLabel,
        kind: 'boolean',
        default: false,
      },
    ],
  },
  {
    id: 'group',
    resultRule: {
      mode: 'verify',
      label: 'Waits for you to verify the proposed families',
    },
    icon: IoGridOutline,
    label: 'Group',
    description: 'Propose template families',
    jobKind: 'group',
    localEnabled: false,
    disabledReason:
      'Work in progress: proposed families will need your approval',
    flow: [
      { label: 'Embed images', icon: IoScanOutline },
      { label: 'Compare', icon: IoGitMergeOutline },
      { label: 'Propose families', icon: IoGridOutline },
    ],
    options: [
      {
        id: 'method',
        label: 'Method',
        kind: 'select',
        default: 'embeddings',
        choices: [
          { value: 'embeddings', label: 'Embeddings', icon: IoScanOutline },
        ],
      },
      {
        id: 'colorSignal',
        label: 'Use colour signal',
        kind: 'boolean',
        default: true,
      },
      {
        id: 'backgroundMask',
        label: 'Background mask',
        kind: 'boolean',
        default: false,
      },
      {
        id: 'visionTiebreak',
        label: 'Vision tiebreak',
        kind: 'boolean',
        default: false,
      },
    ],
  },
  {
    id: 'order',
    icon: IoListOutline,
    label: 'Order',
    description: 'No automatic step yet',
    jobKind: null,
    localEnabled: false,
    disabledReason: 'Order is manual: drag families to reorder',
    options: [],
  },
]

export const newRunStages = pipelineStages.filter(
  (
    stage
  ): stage is StageDefinition & {
    id: Exclude<StageDefinition['id'], 'order' | 'colors'>
  } => !stage.legacyResearch && stage.id !== 'order' && stage.id !== 'colors'
)

export type PipelineCapabilities = Awaited<
  ReturnType<typeof readLocalWorkerCapabilities>
>

/** Explain whether the current worker and deployment can execute the selected stage. */
export function stageAvailability(
  stage: StageDefinition,
  local: boolean,
  capabilities?: PipelineCapabilities
) {
  // A stage that is not ready says so before any worker capability is consulted.
  if (local && !stage.localEnabled && stage.disabledReason)
    return stage.disabledReason
  if (
    local &&
    (stage.id === 'group' ||
      stage.id === 'find-image' ||
      stage.id === 'enhance-image')
  ) {
    if (!capabilities) return 'Local worker not reporting'
    if (stage.id === 'group') {
      if (!capabilities.group.available)
        return capabilities.group.reason ?? 'Grouping is unavailable'
      if (!capabilities.embeddings.available)
        return (
          capabilities.embeddings.reason ?? 'No grouping methods are available'
        )
    } else if (stage.id === 'enhance-image') {
      if (!capabilities[stage.id].available)
        return (
          capabilities[stage.id].reason ?? 'Image enhancement is unavailable'
        )
    } else if (!capabilities['find-image'].available) {
      return 'reason' in capabilities['find-image']
        ? capabilities['find-image'].reason
        : 'Image search is unavailable'
    }
  }
  return stage.id === 'tag' || (local && stage.localEnabled)
    ? undefined
    : local
      ? stage.disabledReason
      : 'Coming soon'
}

/** List the requested stages that the run menu keeps disabled, whatever started the run. */
export function disabledRunStages(stages: readonly string[]) {
  return pipelineStages
    .filter(
      (stage) =>
        !stage.localEnabled && stage.disabledReason && stages.includes(stage.id)
    )
    .map((stage) => stage.id)
}

const stepReasons: Record<string, string> = {
  no_sources: 'No usable source page was found.',
  no_saved_sources: 'No usable saved source was available.',
  no_supported_fields: 'The source did not support a suggestion.',
  missing_wiki_link: 'The required Wiki link was not produced.',
  missing_description: 'The required description was not produced.',
  missing_image: 'The plate image could not be read.',
  stage_failed: 'The worker could not finish this step.',
  upstream_failed: 'An earlier step failed. This step did not run.',
  upstream_skipped: 'An earlier step was skipped for this plate.',
  group_member_failed:
    'Grouping requires the full selection. At least one plate failed an earlier step.',
  group_member_skipped:
    'Grouping requires the full selection. At least one plate was skipped.',
  run_cancelled: 'The remaining work was cancelled.',
  unavailable: 'The worker cannot run this stage.',
}

export function pipelineStepReason(reason: string): string {
  return Object.hasOwn(stepReasons, reason)
    ? stepReasons[reason]
    : reason.replaceAll('_', ' ')
}
