import { createHash } from 'node:crypto'
import type { Plate } from '../catalog/types'
import type { TaggingJob } from '../jobs/types'
import { plateRevision } from '../review/draft/revision'
import { researchContentFields, researchNeeds } from './outcome'
import type { ResearchContentField } from './types'

/** Which content fields a benchmark plate lacked, named for the report. */
export type EnrichCase = 'both' | 'description' | 'facts'
const enrichCases: readonly EnrichCase[] = ['both', 'facts', 'description']

/** The bar agreed on #218 that hosted Research / enrich must clear to be kept. */
export const hostedEnrichBar = {
  minFillRate: 0.8,
  /** Hosted may fall at most this far below the local desktop fill rate. */
  maxLocalGap: 0.1,
  maxCostPerPlateUsd: 0.01,
  plates: 40,
  maxWallMs: 15 * 60_000,
} as const
export const maxEnrichBenchmarkPlates = 40

export type EnrichBenchmarkPlate = {
  plateId: string
  displayName: string
  state: string
  inputRevision: string
  case: EnrichCase
  requested: ResearchContentField[]
}
export type EnrichManifest = {
  schemaVersion: 1
  kind: 'enrich'
  baselineVersion: number
  createdAt: string
  seed: string
  bar: typeof hostedEnrichBar
  plates: EnrichBenchmarkPlate[]
}

/** Name the case for the fields a plate lacks; a plate that lacks nothing has none. */
export function enrichCase(
  requested: readonly ResearchContentField[]
): EnrichCase | null {
  if (requested.length === researchContentFields.length) return 'both'
  if (requested[0] === 'description') return 'description'
  if (requested[0] === 'funFacts') return 'facts'
  return null
}

/**
 * Pick a fixed plate set for each case, taking plates round-robin across the named
 * states so no single state dominates. The order within a state comes from a hash of
 * the seed and plate ID, so the same seed and catalog always give the same set.
 */
export function selectEnrichPlates(
  plates: readonly Plate[],
  options: {
    states: readonly string[]
    counts: Partial<Record<EnrichCase, number>>
    seed: string
  }
): {
  plates: EnrichBenchmarkPlate[]
  /** Plates a case still needed after its candidates ran out. */
  shortfall: Partial<Record<EnrichCase, number>>
} {
  const total = enrichCases.reduce(
    (sum, name) => sum + (options.counts[name] ?? 0),
    0
  )
  if (total > maxEnrichBenchmarkPlates)
    throw new Error(
      `The benchmark takes at most ${maxEnrichBenchmarkPlates} plates`
    )
  const rank = (id: string) =>
    createHash('sha256').update(`${options.seed}/${id}`).digest('hex')
  const selected: EnrichBenchmarkPlate[] = []
  const shortfall: Partial<Record<EnrichCase, number>> = {}
  for (const name of enrichCases) {
    const wanted = options.counts[name] ?? 0
    const queues = options.states.map((state) =>
      plates
        .filter(
          (plate) =>
            plate.state === state && enrichCase(researchNeeds(plate)) === name
        )
        .sort((a, b) => rank(a.id).localeCompare(rank(b.id)))
    )
    let picked = 0
    while (picked < wanted && queues.some((queue) => queue.length)) {
      for (const queue of queues) {
        const plate = queue.shift()
        if (!plate || picked === wanted) continue
        selected.push({
          plateId: plate.id,
          displayName: plate.displayName,
          state: plate.state,
          inputRevision: plateRevision(plate),
          case: name,
          requested: researchNeeds(plate),
        })
        picked++
      }
    }
    if (picked < wanted) shortfall[name] = wanted - picked
  }
  return { plates: selected, shortfall }
}

type FieldTally = { requested: number; filled: number; fillRate: number }
export type EnrichRow = {
  plateId: string
  case: EnrichCase
  requested: ResearchContentField[]
  filled: ResearchContentField[]
  /** Job outcome: completed, a stage error such as no_sources, or the failure reason. */
  outcome: string
  durationMs: number | null
}
export type EnrichScore = {
  route: 'hosted' | 'local' | 'mixed' | 'unknown'
  plates: number
  requestedFields: number
  filledFields: number
  fillRate: number
  byCase: Partial<Record<EnrichCase, FieldTally & { plates: number }>>
  byField: Record<ResearchContentField, FieldTally>
  failed: { plateId: string; reason: string }[]
  /** Hosted Gateway charges. Unknown when any model call reported no charge. */
  cost: { usd: number | null; perPlateUsd: number | null; missing: number }
  time: { wallMs: number | null; p50Ms: number | null; p90Ms: number | null }
  bar: {
    fillRate: boolean
    /** Null until the local desktop fill rate on the same plates is supplied. */
    localGap: boolean | null
    /** Null for a local run, which has no per-call charge. */
    cost: boolean | null
    time: boolean
    passed: boolean
  }
  rows: EnrichRow[]
}

const micro = (usd: number) => Math.round(usd * 1e6) / 1e6
const rate = (filled: number, requested: number) =>
  requested ? filled / requested : 1

/** Nearest-rank percentile over completed job durations. */
function percentile(values: number[], p: number) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

/**
 * Report which requested fields a finished job filled. A description counts when the
 * suggestion carries captured sources; facts count when at least one cites a captured
 * page. The suggestion already passed evidence validation when the job reported it.
 */
function filledFields(
  job: TaggingJob | undefined,
  requested: ResearchContentField[]
): ResearchContentField[] {
  const suggestion = job?.result?.fieldSuggestion
  if (job?.state !== 'completed' || suggestion?.kind !== 'fields') return []
  const sources = new Set(suggestion.sources)
  return requested.filter((field) =>
    field === 'description'
      ? !!suggestion.fields.description?.trim() && sources.size > 0
      : (suggestion.fields.funFacts ?? []).some(
          (fact) => !!fact.sourceUrl && sources.has(fact.sourceUrl)
        )
  )
}

/**
 * Score a finished Research / enrich run against the manifest and the agreed bar. Every
 * manifest plate stays in the denominator: a failed or missing job fills nothing. Cost
 * counts every attempt, because a retried plate was charged for each one.
 */
export function scoreEnrichRun(
  manifest: Pick<EnrichManifest, 'plates' | 'bar'>,
  runs: { createdAt?: number; jobs: TaggingJob[] }[],
  options: { localFillRate?: number } = {}
): EnrichScore {
  const ids = new Set(manifest.plates.map((entry) => entry.plateId))
  const jobs = runs
    .flatMap((run) => run.jobs)
    .filter((job) => job.stage === 'research' && ids.has(job.plateId))
  const latest = new Map<string, TaggingJob>()
  for (const job of jobs) {
    const prior = latest.get(job.plateId)
    if (
      !prior ||
      (job.queueAttempt ?? 0) > (prior.queueAttempt ?? 0) ||
      ((job.queueAttempt ?? 0) === (prior.queueAttempt ?? 0) &&
        job.createdAt >= prior.createdAt)
    )
      latest.set(job.plateId, job)
  }
  const rows: EnrichRow[] = manifest.plates.map((entry) => {
    const job = latest.get(entry.plateId)
    return {
      plateId: entry.plateId,
      case: entry.case,
      requested: entry.requested,
      filled: filledFields(job, entry.requested),
      outcome: !job
        ? 'not_run'
        : job.state === 'completed'
          ? (job.result?.stageError ?? 'completed')
          : (job.failure ?? job.state),
      durationMs:
        job?.state === 'completed' ? (job.result?.durationMs ?? null) : null,
    }
  })
  const tally = (selected: EnrichRow[], field?: ResearchContentField) => {
    const requested = selected.reduce(
      (sum, row) =>
        sum + row.requested.filter((f) => !field || f === field).length,
      0
    )
    const filled = selected.reduce(
      (sum, row) =>
        sum + row.filled.filter((f) => !field || f === field).length,
      0
    )
    return { requested, filled, fillRate: rate(filled, requested) }
  }
  const total = tally(rows)
  const routes = new Set(jobs.map((job) => job.route ?? 'unknown'))
  const route =
    routes.size === 1
      ? ([...routes][0] as EnrichScore['route'])
      : routes.size
        ? 'mixed'
        : 'unknown'
  let usd = 0
  let missing = 0
  if (route !== 'local')
    for (const job of jobs) {
      const usage = job.result?.usage
      if (typeof usage?.costUsd === 'number') usd += usage.costUsd
      else if ((usage?.modelCalls ?? 0) > 0 || (!job.result && job.eve))
        missing++
      missing += usage?.missingModelCosts ?? 0
    }
  const cost =
    route === 'local'
      ? { usd: null, perPlateUsd: null, missing: 0 }
      : {
          usd: micro(usd),
          perPlateUsd: missing ? null : micro(usd / rows.length),
          missing,
        }
  const ended = [...latest.values()].map(
    (job) => job.endedAt ?? job.completedAt
  )
  const started = [
    ...runs.flatMap((run) =>
      run.createdAt === undefined ? [] : [run.createdAt]
    ),
    ...jobs.map((job) => job.createdAt),
  ]
  const allEnded =
    latest.size === rows.length && ended.every((at) => at !== undefined)
  const wallMs =
    allEnded && started.length
      ? Math.max(...(ended as number[])) - Math.min(...started)
      : null
  const durations = rows.flatMap((row) =>
    row.durationMs === null ? [] : [row.durationMs]
  )
  const bar = manifest.bar
  const fillRate = total.fillRate >= bar.minFillRate
  const localGap =
    options.localFillRate === undefined
      ? null
      : total.fillRate >= options.localFillRate - bar.maxLocalGap - 1e-9
  const costPass =
    route === 'local'
      ? null
      : cost.perPlateUsd !== null && cost.perPlateUsd <= bar.maxCostPerPlateUsd
  const time =
    rows.length === bar.plates && wallMs !== null && wallMs < bar.maxWallMs
  return {
    route,
    plates: rows.length,
    requestedFields: total.requested,
    filledFields: total.filled,
    fillRate: total.fillRate,
    byCase: Object.fromEntries(
      enrichCases.flatMap((name) => {
        const selected = rows.filter((row) => row.case === name)
        return selected.length
          ? [[name, { plates: selected.length, ...tally(selected) }]]
          : []
      })
    ),
    byField: Object.fromEntries(
      researchContentFields.map((field) => [field, tally(rows, field)])
    ) as Record<ResearchContentField, FieldTally>,
    failed: rows.flatMap((row) =>
      row.outcome === 'completed' || row.outcome.startsWith('no_')
        ? []
        : [{ plateId: row.plateId, reason: row.outcome }]
    ),
    cost,
    time: {
      wallMs,
      p50Ms: percentile(durations, 0.5),
      p90Ms: percentile(durations, 0.9),
    },
    bar: {
      fillRate,
      localGap,
      cost: costPass,
      time,
      passed: fillRate && localGap === true && costPass !== false && time,
    },
    rows,
  }
}

/**
 * Estimate the Gateway charge for a hosted run from each plate's captured evidence.
 * Plates without evidence, or that need no synthesis, make no model call. Tokens are
 * approximated as four characters each.
 */
export function estimateEnrichCost(
  plates: { evidenceChars: number; synthesis: boolean }[],
  price: {
    overheadTokens: number
    outputTokens: number
    callsPerPlate: number
    inputUsdPerMTok: number
    outputUsdPerMTok: number
  }
) {
  const charged = plates.filter(
    (plate) => plate.synthesis && plate.evidenceChars > 0
  )
  const totalUsd = charged.reduce(
    (sum, plate) =>
      sum +
      price.callsPerPlate *
        (((Math.ceil(plate.evidenceChars / 4) + price.overheadTokens) *
          price.inputUsdPerMTok +
          price.outputTokens * price.outputUsdPerMTok) /
          1e6),
    0
  )
  return {
    synthesisPlates: charged.length,
    totalUsd,
    perPlateUsd: plates.length ? totalUsd / plates.length : 0,
  }
}
