import { DEFAULT_HOSTED_RESEARCH_MODEL } from '../lib/research/models/models'
import { readFile, mkdir, writeFile, access } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { plateRevision } from '../lib/review/revision'
import type { Snapshot } from '../lib/catalog/types'
import { createHash } from 'node:crypto'
import { Client } from 'eve/client'
import { fileResearchState } from '../lib/research/stores/file-state'
import { hostedResearchResult } from '../lib/research/runtime'
import { researchRequestMessage } from '../lib/research/request'
import { runLegacyResearchArtifact } from './research/research-legacy'
import {
  loadResearchArtifacts,
  capturedSources,
} from './research/research-artifact'
import type {
  ResearchInput,
  ResearchResult,
  EvidenceSource,
} from '../lib/research/types'
import type { TaggingJob } from '../lib/jobs/types'
import {
  estimateEnrichCost,
  hostedEnrichBar,
  scoreEnrichRun,
  selectEnrichPlates,
  type EnrichManifest,
} from '../lib/research/enrich-benchmark'
import { enrichmentTargets } from '../lib/research/enrichment'
import {
  enrichmentPrompt,
  needsEnrichmentSynthesis,
} from '../lib/research/enrichment-result'
import { prepareEnrichment } from './pipeline/research'
import type { WorkerPlate } from './run'

/**
 * Parse the research benchmark's executor, corpus, output and timing options from its
 * arguments.
 */
export function researchRunOptions(args: string[]) {
  /** Read the command-line value associated with a benchmark option. */
  const value = (key: string) => {
    const at = args.indexOf(key)
    return at < 0 ? undefined : args[at + 1]
  }
  const run = args.includes('--run')
  const budgetUsd = Number(value('--budget-usd') ?? 0)
  if (run && (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 2))
    throw new Error('Running requires a positive --budget-usd')
  return {
    run,
    budgetUsd,
    input: value('--input'),
    output: value('--output'),
    manifest: value('--manifest'),
    executor: value('--executor') ?? 'eve',
    baseline: value('--baseline'),
  }
}

/**
 * Freeze the corpus against one versioned snapshot so each executor receives identical
 * plate inputs.
 */
export function freezeResearchInputs(
  snapshot: Snapshot,
  corpus: { plateId: string; split: string }[]
): (ResearchInput & { split: string })[] {
  return corpus.map((item) => {
    const plate = snapshot.plates.find((plate) => plate.id === item.plateId)
    if (!plate) throw new Error(`Missing corpus plate: ${item.plateId}`)
    return {
      plateId: plate.id,
      displayName: plate.displayName,
      state: plate.state,
      inputRevision: plateRevision(plate),
      baselineVersion: snapshot.version,
      split: item.split,
    }
  })
}

type BenchmarkExecutors = {
  desktop?: (input: ResearchInput) => Promise<{
    result: ResearchResult
    raw?: import('./research/research-legacy').LegacyOutcome
  }>
  control?: (
    input: ResearchInput,
    sources: EvidenceSource[]
  ) => Promise<
    Pick<ResearchResult, 'draft' | 'rejected' | 'durationMs' | 'cost'>
  >
}
/**
 * Run the benchmark inputs with the selected executor and persist comparable artifacts
 * for each plate.
 */
export async function executeResearchBenchmark(
  options: Pick<
    ReturnType<typeof researchRunOptions>,
    'run' | 'budgetUsd' | 'executor'
  > &
    Partial<ReturnType<typeof researchRunOptions>>,
  executors: BenchmarkExecutors = {}
) {
  if (
    !options.manifest ||
    !options.output?.startsWith('eval-results/research-')
  )
    throw new Error(
      'A frozen --manifest and eval-results/research-* output directory are required'
    )
  if (!['desktop', 'eve', 'control'].includes(options.executor))
    throw new Error('Unknown benchmark executor')
  if (
    options.executor !== 'desktop' &&
    process.env.RESEARCH_ENABLE_MODEL_CALLS !== 'true'
  )
    throw new Error('Model calls are disabled')
  if (options.budgetUsd !== Number(process.env.RESEARCH_BUDGET_USD ?? '2'))
    throw new Error('--budget-usd must match the shared runtime campaign cap')
  const manifestText = await readFile(resolve(options.manifest), 'utf8')
  const manifest = JSON.parse(manifestText) as { inputs: ResearchInput[] }
  if (!manifest.inputs.length || manifest.inputs.length > 20)
    throw new Error('Benchmark requires 1–20 frozen inputs')
  const baseline =
    options.executor === 'control'
      ? await loadResearchArtifacts(
          options.baseline ?? 'eval-results/research-baseline',
          manifest.inputs
        )
      : []
  const hash = createHash('sha256').update(manifestText).digest('hex')
  await mkdir(options.output, { recursive: true })
  const config = {
    manifestSha256: hash,
    executor: options.executor,
    budgetUsd: options.budgetUsd,
    model:
      options.executor !== 'desktop'
        ? DEFAULT_HOSTED_RESEARCH_MODEL
        : 'gemma4:12b',
    promptVersion: 'research-v1',
    searchVariant: process.env.RESEARCH_SEARCH_PROVIDER ?? 'existing',
    searchProviders: {
      serper: !!process.env.SERPER_API_KEY,
      brave: !!process.env.BRAVE_API_KEY,
    },
    cache: 'persistent-cache-state-recorded-as-unknown',
    paidCampaign: process.env.RESEARCH_BUDGET_ID,
  }
  const configFile = resolve(options.output, 'configuration.json')
  try {
    await writeFile(configFile, JSON.stringify(config, null, 2), { flag: 'wx' })
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      (await readFile(configFile, 'utf8')) !== JSON.stringify(config, null, 2)
    )
      throw error
  }
  const client = new Client({
    baseUrl: process.env.RESEARCH_BENCHMARK_EVE_URL ?? 'http://localhost:4283',
  })
  const state = fileResearchState('.eve/research')
  for (const input of manifest.inputs) {
    const output = resolve(options.output, `${input.plateId}.json`)
    try {
      await access(output)
      continue
    } catch {}
    const started = Date.now()
    try {
      if (options.executor === 'control') {
        const captured = baseline.find(
          (row) => row.input.plateId === input.plateId
        )!
        if (captured.error)
          throw new Error(`Baseline unavailable: ${captured.error}`)
        const sources = capturedSources(captured)
        if (!sources.length) {
          await writeFile(
            output,
            JSON.stringify({
              schemaVersion: 1,
              input,
              result: null,
              sources,
              skipped: 'no_captured_sources',
            }),
            { flag: 'wx' }
          )
          continue
        }
        const { synthesizeCapturedEvidence } =
          await import('../lib/research/control')
        const synthesis = executors.control
          ? await executors.control(input, sources)
          : await synthesizeCapturedEvidence(
              input,
              sources,
              state,
              `control-v1/${input.plateId}`
            )
        const result = {
          ...hostedResearchResult(
            input,
            { draft: synthesis.draft, rejected: synthesis.rejected, sources },
            { durationMs: synthesis.durationMs, counters: {} }
          ),
          cost: synthesis.cost,
        }
        await writeFile(
          output,
          JSON.stringify({ schemaVersion: 1, input, result }, null, 2),
          { flag: 'wx' }
        )
        console.log(
          JSON.stringify({
            plateId: input.plateId,
            status: 'completed',
            usd: result.cost.usd,
          })
        )
        continue
      }
      if (options.executor === 'desktop') {
        if (
          !executors.desktop &&
          (!process.env.RESEARCH_LEGACY_ROOT ||
            !process.env.RESEARCH_LEGACY_REVISION)
        )
          throw new Error('Frozen legacy root/revision are required')
        const saved = executors.desktop
          ? await executors.desktop(input)
          : await runLegacyResearchArtifact(input, {
              legacyRoot: process.env.RESEARCH_LEGACY_ROOT!,
              expectedRevision: process.env.RESEARCH_LEGACY_REVISION!,
              model: 'gemma4:12b',
            })
        const { result } = saved
        await writeFile(
          output,
          JSON.stringify({ schemaVersion: 1, input, ...saved }, null, 2),
          { flag: 'wx' }
        )
        console.log(
          JSON.stringify({ plateId: input.plateId, status: result.status })
        )
        continue
      }
      const receiptFile = resolve(
        options.output,
        `${input.plateId}.receipt.json`
      )
      let receipt: { sessionId: string; deliveryId: string }
      try {
        receipt = JSON.parse(await readFile(receiptFile, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const operationId = createHash('sha256')
          .update(hash + '/' + options.output + '/' + input.plateId)
          .digest('hex')
        const response = await client.fetch('/eve/v1/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operationId,
            message: researchRequestMessage(input),
          }),
        })
        if (!response.ok)
          throw new Error(`Eve dispatch status ${response.status}`)
        receipt = await response.json()
        await writeFile(receiptFile, JSON.stringify(receipt), { flag: 'wx' })
      }
      const runId = `${receipt.sessionId}/turn_0`
      let settled: {
        outcome: string
        costUsd?: number
        missingModelCosts?: number
      } | null = null
      while (Date.now() - started < 310000) {
        settled = await state.read(`eve-outcome/${runId}`)
        if (settled) break
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      const draft = await state.read<
        Pick<
          import('../lib/research/types').ResearchResult,
          'draft' | 'sources' | 'rejected'
        >
      >(`draft/${runId}`)
      const counters =
        (await state.read<Record<string, number>>(`limits/${runId}`)) ?? {}
      const events = (
        await client.sessions.attach(receipt.sessionId).snapshot()
      ).events
      const result = draft
        ? hostedResearchResult(input, draft, {
            durationMs: Date.now() - started,
            counters,
          })
        : null
      const nativeCost = await state.read<{ usd: number; missing: number }>(
        `native-search-cost/${runId}`
      )
      if (result && settled?.costUsd !== undefined)
        result.cost = {
          usd: settled.costUsd + (nativeCost?.usd ?? 0),
          missing:
            (settled.missingModelCosts ?? 0) +
            (nativeCost
              ? nativeCost.missing
              : Number(!!counters['web-search'])),
        }
      await writeFile(
        output,
        JSON.stringify(
          {
            schemaVersion: 1,
            input,
            receipt,
            settled,
            result,
            durationMs: Date.now() - started,
            cost: {
              usd:
                settled?.costUsd === undefined
                  ? null
                  : settled.costUsd + (nativeCost?.usd ?? 0),
              missing: Number(!draft) + (nativeCost?.missing ?? 0),
            },
            events,
            error: !draft ? (settled?.outcome ?? 'timeout') : null,
          },
          null,
          2
        ),
        { flag: 'wx' }
      )
      console.log(
        JSON.stringify({
          plateId: input.plateId,
          status: result?.status ?? settled?.outcome ?? 'timeout',
          usd: settled?.costUsd ?? null,
        })
      )
    } catch (error) {
      await writeFile(
        output,
        JSON.stringify(
          {
            schemaVersion: 1,
            input,
            result: null,
            error: error instanceof Error ? error.message : 'failed',
            durationMs: Date.now() - started,
          },
          null,
          2
        ),
        { flag: 'wx' }
      )
      console.log(JSON.stringify({ plateId: input.plateId, status: 'failed' }))
    }
  }
}

/** Gateway list prices for the hosted default model, per million tokens. */
export const hostedEnrichPrice = {
  model: DEFAULT_HOSTED_RESEARCH_MODEL,
  inputUsdPerMTok: 0.1,
  outputUsdPerMTok: 0.4,
  /** Agent instructions, tool schemas and framework prompt sent with each call. */
  overheadTokens: 3000,
  outputTokens: 600,
  /** The draft call, then the reply after submit_draft returns. */
  callsPerPlate: 2,
}

/**
 * Capture each benchmark plate's evidence the way the Research / enrich stage does,
 * without a model call, and record the size of the synthesis prompt it would send.
 */
export async function measureEnrichEvidence(
  manifest: EnrichManifest,
  snapshot: Snapshot,
  prepare: typeof prepareEnrichment = prepareEnrichment,
  pauseMs = 0
) {
  const rows = []
  for (const entry of manifest.plates) {
    // Wikipedia answers bursts with 429, so space the captures out.
    if (rows.length && pauseMs)
      await new Promise((resolve) => setTimeout(resolve, pauseMs))
    const plate = snapshot.plates.find((plate) => plate.id === entry.plateId)!
    const fields = enrichmentTargets(plate, 'fill-missing')
    try {
      const prepared = await prepare(plate as unknown as WorkerPlate, {
        policy: 'fill-missing',
      })
      rows.push({
        plateId: entry.plateId,
        sources: prepared.sources.length,
        synthesis:
          prepared.sources.length > 0 &&
          needsEnrichmentSynthesis(plate, 'fill-missing'),
        evidenceChars: prepared.sources.length
          ? enrichmentPrompt(plate, prepared.sources, 'fill-missing', fields)
              .length
          : 0,
      })
    } catch (error) {
      rows.push({
        plateId: entry.plateId,
        sources: 0,
        synthesis: false,
        evidenceChars: 0,
        error: error instanceof Error ? error.message : 'capture failed',
      })
    }
  }
  return rows
}

/** Accept a saved runs response, one run, or a list of runs, and return the runs. */
export function enrichRunRecords(
  value: unknown
): { createdAt?: number; jobs: TaggingJob[] }[] {
  const list = Array.isArray(value) ? value : [value]
  return list.flatMap((item) => {
    const record = item as {
      selected?: unknown
      runs?: unknown[]
      jobs?: TaggingJob[]
    }
    if (record?.selected) return enrichRunRecords(record.selected)
    if (Array.isArray(record?.jobs))
      return [record as { createdAt?: number; jobs: TaggingJob[] }]
    if (Array.isArray(record?.runs)) return enrichRunRecords(record.runs)
    throw new Error('Run file has no jobs; save the run detail response')
  })
}

/**
 * Freeze the Research / enrich plate set, optionally measure its evidence for a cost
 * estimate, or score a finished run against the agreed bar. No mode calls a model.
 */
async function enrichMain(args: string[]) {
  /** Read the command-line value associated with an option. */
  const value = (key: string) => {
    const at = args.indexOf(key)
    return at < 0 ? undefined : args[at + 1]
  }
  const output = value('--output')
  if (!output?.startsWith('eval-results/research-'))
    throw new Error('Output must be under eval-results/research-*')
  if (args.includes('--enrich-score')) {
    const manifest = JSON.parse(
      await readFile(resolve(value('--manifest') ?? ''), 'utf8')
    ) as EnrichManifest
    const runs = []
    for (const file of (value('--runs') ?? '').split(',').filter(Boolean))
      runs.push(
        ...enrichRunRecords(JSON.parse(await readFile(resolve(file), 'utf8')))
      )
    const local = value('--local-fill')
    const score = scoreEnrichRun(manifest, runs, {
      ...(local === undefined ? {} : { localFillRate: Number(local) }),
    })
    await mkdir(dirname(resolve(output)), { recursive: true })
    await writeFile(resolve(output), JSON.stringify(score, null, 2) + '\n', {
      flag: 'wx',
    })
    // The per-plate rows are in the output file; print the summary only.
    console.log(JSON.stringify({ ...score, rows: undefined }, null, 2))
    return
  }
  const snapshot = JSON.parse(
    await readFile(resolve(value('--input') ?? ''), 'utf8')
  ) as Snapshot
  const count = (key: string) => Number(value(key) ?? 0)
  const seed = value('--seed') ?? `v${snapshot.version}`
  const selected = selectEnrichPlates(snapshot.plates, {
    states: (value('--states') ?? '').split(',').filter(Boolean),
    counts: {
      both: count('--both'),
      facts: count('--facts'),
      description: count('--description'),
    },
    seed,
  })
  const manifest: EnrichManifest = {
    schemaVersion: 1,
    kind: 'enrich',
    baselineVersion: snapshot.version,
    createdAt: new Date().toISOString(),
    seed,
    bar: hostedEnrichBar,
    plates: selected.plates,
  }
  await mkdir(dirname(resolve(output)), { recursive: true })
  await writeFile(resolve(output), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  })
  const evidence = args.includes('--measure-evidence')
    ? await measureEnrichEvidence(
        manifest,
        snapshot,
        prepareEnrichment,
        Number(value('--pause-ms') ?? 3000)
      )
    : null
  if (evidence)
    await writeFile(
      resolve(dirname(resolve(output)), 'evidence.json'),
      JSON.stringify(evidence, null, 2) + '\n',
      { flag: 'wx' }
    )
  console.log(
    JSON.stringify(
      {
        manifest: output,
        plates: manifest.plates.length,
        shortfall: selected.shortfall,
        ...(evidence
          ? {
              withSources: evidence.filter((row) => row.sources).length,
              estimate: {
                ...hostedEnrichPrice,
                ...estimateEnrichCost(evidence, hostedEnrichPrice),
              },
            }
          : {}),
      },
      null,
      2
    )
  )
}

/**
 * Load the benchmark settings and corpus, execute the run and report its artifact
 * manifest.
 */
async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--enrich-plan') || args.includes('--enrich-score'))
    return enrichMain(args)
  const options = researchRunOptions(args)
  const corpus = JSON.parse(
    await readFile(resolve('fixtures/research-eval.json'), 'utf8')
  )
  if (options.run) {
    await executeResearchBenchmark(options)
    return
  }
  if (!options.input) {
    console.log(
      JSON.stringify({
        mode: 'validate-only',
        plates: corpus.plates.length,
        next: 'Pass --input snapshot.json --output eval-results/research-baseline/manifest.json to freeze inputs. No external requests were sent.',
      })
    )
    return
  }
  if (!options.output?.startsWith('eval-results/research-'))
    throw new Error('Manifest output must be under eval-results/research-*')
  const snapshot = JSON.parse(
    await readFile(resolve(options.input), 'utf8')
  ) as Snapshot
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    rubric: corpus.rubric,
    inputs: freezeResearchInputs(snapshot, corpus.plates),
  }
  await mkdir(dirname(resolve(options.output)), { recursive: true })
  await writeFile(
    resolve(options.output),
    JSON.stringify(manifest, null, 2) + '\n',
    { flag: 'wx' }
  )
  console.log(
    JSON.stringify({ manifest: options.output, plates: manifest.inputs.length })
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
