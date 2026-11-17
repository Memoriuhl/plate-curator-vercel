export type TaggingModel = {
  id: string
  label: string
  runsOn: 'desktop' | 'gateway'
  model: string
  measured: { f1: number; p50Seconds: number; costPerPlate: number | null; plates: number; date: string }
}

export const TAGGING_MODELS = [
  {
    id: 'desktop-gemma4-12b',
    label: 'Gemma 4 12B · desktop GPU',
    runsOn: 'desktop',
    model: 'gemma4:12b',
    measured: { f1: 0.669, p50Seconds: 53.5, costPerPlate: null, plates: 15, date: '2026-11-16' },
  },
  {
    id: 'desktop-gemma4-26b',
    label: 'Gemma 4 26B · desktop GPU',
    runsOn: 'desktop',
    model: 'gemma4:26b',
    measured: { f1: 0.664, p50Seconds: 97.5, costPerPlate: null, plates: 15, date: '2026-11-16' },
  },
  {
    id: 'gateway-gemma4-26b',
    label: 'Gemma 4 26B · AI Gateway',
    runsOn: 'gateway',
    model: 'google/gemma-4-26b-a4b-it',
    measured: { f1: 0.676, p50Seconds: 7.5, costPerPlate: 0.0003, plates: 15, date: '2026-11-16' },
  },
] as const satisfies readonly TaggingModel[]

export type TaggingModelId = (typeof TAGGING_MODELS)[number]['id']

export const DEFAULT_TAGGING_MODEL: TaggingModelId = 'desktop-gemma4-12b'

export function taggingModel(id: unknown): TaggingModel | null {
  return TAGGING_MODELS.find(model => model.id === id) ?? null
}
