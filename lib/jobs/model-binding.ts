import {
  curated,
  pinnedHostedModel,
  searchableCatalog,
  type HostedStep,
} from '../models/catalog'
import type { PipelineRun } from './queue-types'
import {
  DEFAULT_MODEL_CAP,
  fitsModelCap,
  gatewayModelId,
  MODEL_CAP_PRESETS,
  type HostedModelCatalog,
  modelOptionsSchema,
  type HostedModelBinding,
  type PickerModel,
} from '../models/selection'
import {
  DEFAULT_HOSTED_RESEARCH_MODEL,
  RESEARCH_MODELS,
  researchModel,
} from '../research/models'
import {
  chooseTaggingModel,
  DEFAULT_GATEWAY_TAG_MODEL,
  enabledTaggingModels,
  taggingModel,
  type TaggingModel,
} from '../tagging/models'

type Rejected = { ok: false; error: 'bad_request' | 'unavailable' }
type BoundModel = { ok: true; label: string; binding: HostedModelBinding }

export function hostedModelCeiling() {
  const ceiling = Number(process.env.HOSTED_MODEL_MAX_USD_PER_PLATE ?? '0.05')
  return Number.isFinite(ceiling) && ceiling > 0 ? ceiling : 0
}

export async function bindHostedModel(
  step: HostedStep,
  model: string,
  options: unknown
): Promise<BoundModel | Rejected> {
  const parsed = modelOptionsSchema.safeParse(
    options === undefined ? {} : options
  )
  if (!parsed.success) return { ok: false, error: 'bad_request' }
  const { capUsd = DEFAULT_MODEL_CAP, strict = false } = parsed.data
  if (capUsd > hostedModelCeiling()) return { ok: false, error: 'bad_request' }
  try {
    const { available, models } = await searchableCatalog(step, capUsd)
    if (!available) {
      const pinned = pinnedHostedModel(step)
      if (model !== pinned.id) return { ok: false, error: 'unavailable' }
      if (!fitsModelCap(pinned.estimatedUsd, capUsd))
        return { ok: false, error: 'bad_request' }
      return {
        ok: true,
        label: pinned.label,
        binding: {
          model,
          price: pinned.price,
          outputTokensBound: pinned.outputTokensBound,
          capUsd,
          strict,
        },
      }
    }
    const selected = models.find(({ id }) => id === model)
    if (!selected) return { ok: false, error: 'bad_request' }
    const fallbackId =
      step === 'tag' ? DEFAULT_GATEWAY_TAG_MODEL : DEFAULT_HOSTED_RESEARCH_MODEL
    const fallback =
      strict || model === fallbackId
        ? undefined
        : models.find(({ id }) => id === fallbackId)
    if (!strict && model !== fallbackId && !fallback)
      return { ok: false, error: 'unavailable' }
    return {
      ok: true,
      label: selected.label,
      binding: {
        model,
        price: selected.price,
        outputTokensBound: selected.outputTokensBound,
        capUsd,
        strict,
        ...(fallback
          ? {
              fallback: {
                model: fallback.id,
                price: fallback.price,
                outputTokensBound: fallback.outputTokensBound,
              },
            }
          : {}),
      },
    }
  } catch {
    return { ok: false, error: 'unavailable' }
  }
}

export async function chooseRunResearchModel(
  requested: unknown,
  options: unknown,
  hostedEnabled: boolean,
  owner: boolean
) {
  const known = researchModel(
    requested === undefined ? RESEARCH_MODELS[0].id : requested
  )
  if (known?.executor === 'desktop')
    return options === undefined
      ? { ok: true as const, model: known }
      : { ok: false as const, error: 'bad_request' as const }
  if (
    !known &&
    (typeof requested !== 'string' || !gatewayModelId.test(requested))
  )
    return { ok: false as const, error: 'bad_request' as const }
  if (!hostedEnabled || !owner)
    return { ok: false as const, error: 'unavailable' as const }
  const id = known?.model ?? (requested as string)
  const selected = await bindHostedModel('research', id, options)
  if (!selected.ok) return selected
  return {
    ok: true as const,
    model: {
      id: known?.id ?? id,
      executor: 'eve' as const,
      model: id,
      label: selected.label,
    },
    binding: selected.binding,
  }
}

type TagRunChoice =
  | {
      ok: true
      model: Pick<TaggingModel, 'id' | 'label' | 'model' | 'runsOn'>
      binding?: HostedModelBinding
    }
  | Rejected

export async function chooseRunTaggingModel(
  requested: unknown,
  options: unknown,
  owner: boolean,
  runsOn?: TaggingModel['runsOn']
): Promise<TagRunChoice> {
  const enabled = enabledTaggingModels(process.env.TAGGING_MODELS).filter(
    (model) => !runsOn || model.runsOn === runsOn
  )
  const dynamic =
    typeof requested === 'string' && gatewayModelId.test(requested)
  const known = dynamic
    ? undefined
    : chooseTaggingModel(
        requested,
        requested === undefined && !owner
          ? enabled.filter((model) => model.runsOn === 'desktop')
          : enabled,
        process.env.TAGGING_DEFAULT_MODEL
      )
  if (known && !known.ok) return known
  if (known?.model.runsOn === 'desktop')
    return options === undefined ? known : { ok: false, error: 'bad_request' }
  if (!owner || !enabled.some((model) => model.runsOn === 'gateway'))
    return { ok: false, error: 'unavailable' }
  const id = known?.model.model ?? (requested as string)
  const selected = await bindHostedModel('tag', id, options)
  if (!selected.ok) return selected
  return {
    ok: true,
    model: known?.model ?? {
      id,
      label: selected.label,
      model: id,
      runsOn: 'gateway',
    },
    binding: selected.binding,
  }
}

export function hostedResearchModelId(requested: unknown): string | null {
  if (requested === undefined) return DEFAULT_HOSTED_RESEARCH_MODEL
  const known = researchModel(requested)
  if (known?.executor === 'eve') return known.model
  return typeof requested === 'string' && gatewayModelId.test(requested)
    ? requested
    : null
}

export async function hostedModelCatalog(
  step: HostedStep
): Promise<HostedModelCatalog | undefined> {
  const caps = MODEL_CAP_PRESETS.filter((cap) => cap <= hostedModelCeiling())
  const max = caps.at(-1)
  if (!max) return
  try {
    const [preferred, { available, models }] = await Promise.all([
      curated(step, max),
      searchableCatalog(step, max),
    ])
    if (!available) {
      const pinned = pinnedHostedModel(step)
      return {
        caps,
        curated: fitsModelCap(pinned.estimatedUsd, max)
          ? [pickerModel(pinned)]
          : [],
        searchable: [],
        unavailable: true,
      }
    }
    return {
      caps,
      curated: preferred.map(pickerModel),
      searchable: models.map(pickerModel),
    }
  } catch {
    return undefined
  }
}

function pickerModel({
  id,
  label,
  provider,
  estimatedUsd,
  measured,
}: PickerModel): PickerModel {
  return {
    id,
    label,
    provider,
    estimatedUsd,
    ...(measured ? { measured } : {}),
  }
}

export function runUsesHostedModels(run: PipelineRun) {
  return !!(
    run.modelBindings?.research ||
    run.modelBindings?.tag ||
    run.researchModel?.executor === 'eve' ||
    (run.stages.includes('tag') &&
      taggingModel(run.tagModelId ?? run.modelId)?.runsOn === 'gateway')
  )
}
