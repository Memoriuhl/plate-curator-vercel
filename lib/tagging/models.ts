export type TaggingModel = {
  id: string
  label: string
  runsOn: 'desktop' | 'gateway'
  model: string
  measured: {
    f1: number
    p50Seconds: number
    costPerPlate: number | null
    plates: number
    date: string
  }
}

export const TAGGING_MODELS = [
  {
    id: 'desktop-gemma4-12b',
    label: 'Gemma 4 12B',
    runsOn: 'desktop',
    model: 'gemma4:12b',
    measured: {
      f1: 0.669,
      p50Seconds: 53.5,
      costPerPlate: null,
      plates: 15,
      date: '2026-11-16',
    },
  },
  {
    id: 'desktop-gemma4-26b',
    label: 'Gemma 4 26B',
    runsOn: 'desktop',
    model: 'gemma4:26b',
    measured: {
      f1: 0.664,
      p50Seconds: 97.5,
      costPerPlate: null,
      plates: 15,
      date: '2026-11-16',
    },
  },
  {
    id: 'gateway-gemma4-26b',
    label: 'Gemma 4 26B',
    runsOn: 'gateway',
    model: 'google/gemma-4-26b-a4b-it',
    measured: {
      f1: 0.676,
      p50Seconds: 7.5,
      costPerPlate: 0.0003,
      plates: 15,
      date: '2026-11-16',
    },
  },
] as const satisfies readonly TaggingModel[]

export type TaggingModelId = (typeof TAGGING_MODELS)[number]['id']

export const DEFAULT_TAGGING_MODEL: TaggingModelId = 'desktop-gemma4-12b'

/** Resolve a known tagging model by its stable catalog ID. */
export function taggingModel(id: unknown): TaggingModel | null {
  return TAGGING_MODELS.find((model) => model.id === id) ?? null
}

/** Parse the enabled model configuration and discard unrecognized IDs. */
export function enabledTaggingModels(
  setting: string | undefined
): TaggingModel[] {
  if (!setting?.trim())
    return TAGGING_MODELS.filter((model) => model.runsOn === 'desktop')
  return setting.split(',').flatMap((id) => taggingModel(id.trim()) ?? [])
}

export type TaggingChoice =
  | { ok: true; model: TaggingModel }
  | { ok: false; error: 'bad_request' | 'unavailable' }

/**
 * Resolve an allowed tagging model and distinguish an unknown model from a disabled one.
 */
export function chooseTaggingModel(
  requested: unknown,
  enabled: readonly TaggingModel[],
  preferred?: unknown
): TaggingChoice {
  if (requested === undefined) {
    const model =
      enabled.find((m) => m.id === preferred) ??
      enabled.find((m) => m.id === DEFAULT_TAGGING_MODEL) ??
      enabled[0]
    return model ? { ok: true, model } : { ok: false, error: 'unavailable' }
  }
  const model = taggingModel(requested)
  if (!model) return { ok: false, error: 'bad_request' }
  return enabled.some((m) => m.id === model.id)
    ? { ok: true, model }
    : { ok: false, error: 'unavailable' }
}

export const DEFAULT_GATEWAY_TAG_MODEL = TAGGING_MODELS[2].model
export const DEFAULT_GATEWAY_TAG_PRICE = {
  input: 0.00000015,
  output: 0.0000006,
}

export const CURATED_TAG_MODELS = [
  DEFAULT_GATEWAY_TAG_MODEL,
  'google/gemma-4-31b-it',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.8-flash',
  'anthropic/claude-haiku-5.5',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4-nano',
  'alibaba/qwen3.8-flash',
  'amazon/nova-2-lite',
  'mistral/mistral-medium-3.5',
] as const

const CURATED_TAG_MEASUREMENTS: Partial<
  Record<(typeof CURATED_TAG_MODELS)[number], TaggingModel['measured']>
> = {
  'google/gemma-4-26b-a4b-it': {
    f1: 0.647059,
    p50Seconds: 2.717,
    costPerPlate: 0.000333665,
    plates: 15,
    date: '2026-11-18',
  },
  'google/gemma-4-31b-it': {
    f1: 0.653061,
    p50Seconds: 8.959,
    costPerPlate: 0.0002756867,
    plates: 15,
    date: '2026-11-18',
  },
  'google/gemini-3.5-flash-lite': {
    f1: 0.687285,
    p50Seconds: 1.485,
    costPerPlate: 0.0011247,
    plates: 15,
    date: '2026-11-18',
  },
  'google/gemini-3.8-flash': {
    f1: 0.62585,
    p50Seconds: 5.65,
    costPerPlate: 0.0040535,
    plates: 15,
    date: '2026-11-18',
  },
  'anthropic/claude-haiku-5.5': {
    f1: 0.58363,
    p50Seconds: 3.579,
    costPerPlate: 0.0005635933,
    plates: 15,
    date: '2026-11-18',
  },
  'openai/gpt-5.4-mini': {
    f1: 0.596491,
    p50Seconds: 1.337,
    costPerPlate: 0.0013461,
    plates: 15,
    date: '2026-11-18',
  },
  'openai/gpt-5.4-nano': {
    f1: 0.520958,
    p50Seconds: 1.672,
    costPerPlate: 0.0004737533,
    plates: 15,
    date: '2026-11-18',
  },
  'alibaba/qwen3.8-flash': {
    f1: 0.662207,
    p50Seconds: 28.321,
    costPerPlate: 0.000969396,
    plates: 15,
    date: '2026-11-18',
  },
  'amazon/nova-2-lite': {
    f1: 0.618182,
    p50Seconds: 1.623,
    costPerPlate: 0.0008230713,
    plates: 15,
    date: '2026-11-18',
  },
  'mistral/mistral-medium-3.5': {
    f1: 0.601449,
    p50Seconds: 1.41,
    costPerPlate: 0.0019417,
    plates: 15,
    date: '2026-11-18',
  },
}

export function hostedTagMeasurement(model: string) {
  const curated = CURATED_TAG_MODELS.find((id) => id === model)
  return (
    (curated ? CURATED_TAG_MEASUREMENTS[curated] : undefined) ??
    TAGGING_MODELS.find((entry) => entry.model === model)?.measured
  )
}
