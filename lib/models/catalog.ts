import { z } from 'zod'
import { CURATED_RESEARCH_MODELS } from '../research/models'
import { CURATED_TAG_MODELS, TAGGING_MODELS } from '../tagging/models'
import { DEFAULT_MODEL_CAP, fitsModelCap } from './selection'

export type HostedStep = 'research' | 'tag'
export type ModelPrice = { input: number; output: number }

const CATALOG_URL = 'https://ai-gateway.vercel.sh/v1/models'
const CATALOG_TTL_MS = 60 * 60 * 1000
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
let pending: Promise<CatalogEntry[]> | undefined

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
    throw Error('Gateway model catalog unavailable', { cause })
  }
}

function catalog() {
  if (cache && Date.now() < cache.expires) return Promise.resolve(cache.entries)
  return (pending ??= fetchCatalog().finally(() => {
    pending = undefined
  }))
}

export function estimateUsd(price: ModelPrice, tokens: ModelPrice) {
  return price.input * tokens.input + price.output * tokens.output
}

export async function searchable(step: HostedStep, capUsd: number) {
  return (await catalog()).flatMap((model) => {
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
    const measured =
      step === 'tag'
        ? TAGGING_MODELS.find((m) => m.model === id)?.measured
        : undefined
    return [{ ...model, ...(measured ? { measured } : {}) }]
  })
}
