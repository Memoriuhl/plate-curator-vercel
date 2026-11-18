import { defaultImageEnhancement, type ImageEnhancementOptions } from './image-enhancement'
import { shouldReuseSavedSources, type EnrichmentOptions } from '../research/enrichment'

export type PipelineOptions = {
  research?: EnrichmentOptions & Required<Pick<EnrichmentOptions, 'policy'>>
  'enhance-image'?: ImageEnhancementOptions
  'find-image'?: { onlyMissingImage: boolean }
  story?: { redoExisting: boolean }
  tag?: { onlyUnderTagged: boolean }
  group?: { method: 'embeddings'; colorSignal: boolean; backgroundMask: boolean; visionTiebreak: boolean }
}

export const defaultPipelineOptions: Required<PipelineOptions> = {
  research: { policy: 'fill-missing' },
  'find-image': { onlyMissingImage: false },
  'enhance-image': defaultImageEnhancement,
  story: { redoExisting: false },
  tag: { onlyUnderTagged: false },
  group: { method: 'embeddings', colorSignal: true, backgroundMask: false, visionTiebreak: false },
}

export function parsePipelineOptions(input: unknown): PipelineOptions | null {
  if (input === undefined) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [stage, options] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (!Object.hasOwn(defaultPipelineOptions, stage) || !options || typeof options !== 'object' || Array.isArray(options)) return null
    const defaults = defaultPipelineOptions[stage as keyof PipelineOptions]
    if (Object.entries(options).some(([key, entry]) => (!Object.hasOwn(defaults, key) && !(stage === 'research' && key === 'reuseSavedSources')) ||
      (key === 'method' ? entry !== 'embeddings' : key === 'policy' ? entry !== 'fill-missing' && entry !== 'replace' : typeof entry !== 'boolean'))) return null
    result[stage] = { ...defaults, ...options }
  }
  return result as PipelineOptions
}

export function snapshotPipelineOptions(stages: readonly string[], options: PipelineOptions): PipelineOptions {
  const selected: PipelineOptions = Object.fromEntries(Object.keys(defaultPipelineOptions).sort().filter(stage => stages.includes(stage)).map(stage =>
    [stage, { ...defaultPipelineOptions[stage as keyof PipelineOptions], ...options[stage as keyof PipelineOptions] }]))
  if (selected.research && !shouldReuseSavedSources(selected.research)) delete selected.research.reuseSavedSources
  return selected
}
