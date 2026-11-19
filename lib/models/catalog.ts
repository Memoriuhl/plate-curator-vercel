import { z } from 'zod'
import {
  CURATED_RESEARCH_MODELS,
  DEFAULT_HOSTED_RESEARCH_MODEL,
  LEGACY_RESEARCH_PRICES,
  RESEARCH_MODELS,
} from '../research/models'
import {
  CURATED_TAG_MODELS,
  DEFAULT_GATEWAY_TAG_PRICE,
  hostedTagMeasurement,
  TAGGING_MODELS,
} from '../tagging/models'
import { DEFAULT_MODEL_CAP, fitsModelCap } from './selection'

export type HostedStep = 'research' | 'tag'
export type ModelPrice = { input: number; output: number }

const CATALOG_URL = 'https://ai-gateway.vercel.sh/v1/models'
const CATALOG_TTL_MS = 60 * 60 * 1000
const CATALOG_RETRY_MS = 60 * 1000
const CAPABILITY = { research: 'tool-use', tag: 'vision' } as const
// TODO: Use medians when recent Research attempt and Tag result usage can be read
// in a bounded query. The current stores only expose usage by individual run.
const PROFILES = {
  research: { input: 12_000, output: 1_000 },
  tag: { input: 2_500, output: 400 },
}

const price = z
  .union([z.number(), z.string().trim().min(1)])
  .transform(Number)
  .pipe(z.number().nonnegative())
const entry = z.object({
  id: z.string().min(1),
  name: z.string(),
  owned_by: z.string(),
  type: z.literal('language'),
  tags: z.array(z.string()),
  pricing: z.object({ input: price, output: price }),
})
const payload = z.object({ data: z.array(z.unknown()) })
type CatalogEntry = z.infer<typeof entry>

let cache: { expires: number; entries: CatalogEntry[] } | undefined
let pending: Promise<CatalogEntry[] | undefined> | undefined
let retryAt = 0

async function fetchCatalog() {
  try {
    const response = await fetch(CATALOG_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw Error(`HTTP ${response.status}`)
    const { data } = payload.parse(await response.json())
    const entries = data.flatMap((item) => {
      const result = entry.safeParse(item)
      return result.success ? [result.data] : []
    })
    cache = { expires: Date.now() + CATALOG_TTL_MS, entries }
    return entries
  } catch (cause) {
    console.warn(Error('Gateway model catalog unavailable', { cause }))
    retryAt = Date.now() + CATALOG_RETRY_MS
    return cache?.entries
  }
}

function catalog() {
  const now = Date.now()
  if ((cache && now < cache.expires) || now < retryAt)
    return Promise.resolve(cache?.entries)
  return (pending ??= fetchCatalog().finally(() => {
    pending = undefined
  }))
}

export function estimateUsd(price: ModelPrice, tokens: ModelPrice) {
  return price.input * tokens.input + price.output * tokens.output
}

export async function searchableCatalog(step: HostedStep, capUsd: number) {
  const entries = await catalog()
  const models = (entries ?? []).flatMap((model) => {
    if (model.id.endsWith('-batch') || !model.tags.includes(CAPABILITY[step]))
      return []
    const estimatedUsd = estimateUsd(model.pricing, PROFILES[step])
    if (!fitsModelCap(estimatedUsd, capUsd)) return []
    return [
      {
        id: model.id,
        label: model.name,
        provider: model.owned_by,
        price: model.pricing,
        estimatedUsd,
      },
    ]
  })
  return { available: entries !== undefined, models }
}

export async function searchable(step: HostedStep, capUsd: number) {
  return (await searchableCatalog(step, capUsd)).models
}

export function pinnedHostedModel(step: HostedStep) {
  const pinned = step === 'research' ? RESEARCH_MODELS[2] : TAGGING_MODELS[2]
  const price =
    step === 'research'
      ? LEGACY_RESEARCH_PRICES[DEFAULT_HOSTED_RESEARCH_MODEL]
      : DEFAULT_GATEWAY_TAG_PRICE
  return {
    id: pinned.model,
    label: pinned.label,
    provider: 'google',
    price,
    estimatedUsd: estimateUsd(price, PROFILES[step]),
    ...('measured' in pinned
      ? { measured: hostedTagMeasurement(pinned.model) ?? pinned.measured }
      : {}),
  }
}

export async function curated(step: HostedStep, capUsd = DEFAULT_MODEL_CAP) {
  const models = new Map(
    (await searchable(step, capUsd)).map((model) => [model.id, model])
  )
  const curatedIds =
    step === 'research' ? CURATED_RESEARCH_MODELS : CURATED_TAG_MODELS
  return curatedIds.flatMap((id) => {
    const model = models.get(id)
    if (!model) return []
    const measured = step === 'tag' ? hostedTagMeasurement(id) : undefined
    return [{ ...model, ...(measured ? { measured } : {}) }]
  })
}
