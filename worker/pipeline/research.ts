import { z } from 'zod'
import type { Plate } from '../../lib/catalog/types'
import {
  enrichmentTargets,
  shouldReuseSavedSources,
  type EnrichmentOptions,
} from '../../lib/research/enrichment'
import {
  enrichmentNotes,
  enrichmentPrompt,
  enrichmentPromptVersion,
  enrichmentSuggestion,
  needsEnrichmentSynthesis,
  wikiOnlyDraft,
} from '../../lib/research/enrichment-result'
import { researchDraftSchema } from '../../lib/research/validate'
import { fetchResearchPage } from '../../lib/research/sources/fetch-page'
import { evidenceSource } from '../../lib/research/evidence'
import type { EvidenceSource } from '../../lib/research/types'
import { researchModel } from '../../lib/research/models/models'
import { storyUrl } from '../../lib/review/fields'
import type { StageResult, WorkerPlate } from '../run'
import { gatherWikipedia, standardPlateReference, wikiTitle } from './sources'
import { findWikipediaLink } from './wiki'
import { extractJson } from '../model'
import { captureAlaskaPlateSources } from './alaska-sources'

const alabamaRevenue = 'www.revenue.alabama.gov'

/** Capture a sourced plate page when Alabama DOR supplied the plate image. */
async function captureAlabamaPlatePage(
  plate: Partial<Pick<WorkerPlate, 'displayName' | 'state' | 'sourceUrl'>>,
  fetchPage: typeof fetchResearchPage,
  saved?: ReadonlyMap<string, EvidenceSource>
) {
  const provenance = URL.parse(plate.sourceUrl ?? '')
  if (
    plate.state !== 'AL' ||
    !plate.displayName ||
    provenance?.hostname !== alabamaRevenue
  )
    return null
  const slug = plate.displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (!slug) return null
  const url = `https://${alabamaRevenue}/license-plates/${slug}/`
  const page =
    saved?.get(url) ??
    (await fetchPage(url, { reserve: async () => true, now: Date.now }))
  const expectedTitle =
    `${plate.displayName} - Alabama Department of Revenue`.toLowerCase()
  return page?.url === url && page.title.toLowerCase() === expectedTitle
    ? page
    : null
}

export async function captureEnrichment(
  plate: WorkerPlate,
  request: typeof fetch = fetch,
  fetchPage = fetchResearchPage
): Promise<{ sources: EvidenceSource[]; wikiUrl: string | null }> {
  // Reuse the Wiki adapter's subject/jurisdiction match. The gather adapter then
  // fetches that page once, plus its bounded state/subject passages.
  const [wiki, official] = await Promise.all([
    findWikipediaLink(plate, request),
    captureAlabamaPlatePage(plate, fetchPage),
  ])
  const wikiUrl =
    wiki.fieldSuggestion?.kind === 'fields'
      ? (wiki.fieldSuggestion.fields.wikiUrl ?? null)
      : null
  const sources = await gatherWikipedia(
    { ...plate, wikiUrl: wikiUrl ?? plate.wikiUrl },
    request
  )
  return {
    sources: [
      ...(official ? [official] : []),
      ...sources.map((source) => evidenceSource(source)),
    ],
    wikiUrl,
  }
}

type SavedSourceLinks = Pick<
  WorkerPlate,
  'wikiUrl' | 'sourceUrl' | 'readMore' | 'funFacts'
> &
  Partial<Pick<WorkerPlate, 'displayName' | 'state'>>

export async function captureSavedEnrichment(
  plate: SavedSourceLinks,
  fetchPage = fetchResearchPage,
  requireReference = false
): Promise<{ sources: EvidenceSource[]; wikiUrl: string | null }> {
  const urls = [
    plate.wikiUrl,
    plate.sourceUrl,
    ...(plate.readMore ?? []).map((link) => link.url),
    ...(plate.funFacts ?? []).map((fact) =>
      typeof fact === 'object' ? fact?.sourceUrl : undefined
    ),
  ]
  const saved = [
    ...new Set(
      urls.flatMap((url) =>
        typeof url === 'string' && url.trim() ? [url.trim()] : []
      )
    ),
  ].slice(0, 3)
  const sources = new Map<string, EvidenceSource>()
  const fetched = await Promise.all(
    saved.map((url) =>
      fetchPage(url, { reserve: async () => true, now: Date.now })
    )
  )
  if (requireReference && (!storyUrl(plate.wikiUrl) || !fetched[0]))
    return { sources: [], wikiUrl: null }
  let wikiUrl: string | null = null
  for (const source of fetched) {
    if (!source || sources.has(source.url)) continue
    const url = new URL(source.url)
    if (
      url.hostname === 'en.wikipedia.org' &&
      url.pathname.startsWith('/wiki/')
    ) {
      sources.set(source.url, { ...source, kind: 'wikipedia' })
      wikiUrl ??= source.url
    } else sources.set(source.url, source)
  }
  // Fetch the exact issuer page alongside saved links without doing a new search.
  const official =
    requireReference &&
    (await captureAlabamaPlatePage(plate, fetchPage, sources))
  if (official) sources.delete(official.url)
  return {
    sources: [...(official ? [official] : []), ...sources.values()],
    wikiUrl,
  }
}

export type PreparedEnrichment = Awaited<
  ReturnType<typeof captureEnrichment>
> & { sourceLookupSkipped?: true }

export async function prepareEnrichment(
  plate: WorkerPlate,
  options: EnrichmentOptions,
  {
    capture = captureEnrichment,
    captureSaved = captureSavedEnrichment,
    fetchPage = fetchResearchPage,
  }: {
    capture?: typeof captureEnrichment
    captureSaved?: typeof captureSavedEnrichment
    fetchPage?: typeof fetchResearchPage
  } = {}
): Promise<PreparedEnrichment> {
  if (shouldReuseSavedSources(options))
    return { ...(await captureSaved(plate)), sourceLookupSkipped: true }
  const official = needsEnrichmentSynthesis(
    plate,
    options.policy ?? 'fill-missing'
  )
    ? captureAlaskaPlateSources(plate, fetchPage)
    : Promise.resolve([])
  const withOfficial = async (
    result: Awaited<ReturnType<typeof captureEnrichment>>
  ) => {
    const issuerSources = await official
    const urls = new Set(issuerSources.map((source) => source.url))
    return {
      ...result,
      sources: [
        ...issuerSources,
        ...result.sources.filter((source) => !urls.has(source.url)),
      ],
    }
  }
  // A standard plate's saved link is often a generic article (e.g. wiki/Standard).
  // Reuse it only when it is the state's registration plates article.
  const reference = standardPlateReference(plate)
  if (
    options.policy !== 'replace' &&
    storyUrl(plate.wikiUrl) &&
    (!reference || wikiTitle(plate.wikiUrl) === reference)
  ) {
    const saved = await captureSaved(plate, fetchPage, true)
    if (saved.sources.length)
      return { ...(await withOfficial(saved)), sourceLookupSkipped: true }
    if ((await official).some((source) => source.url === plate.wikiUrl)) {
      return {
        sources: await official,
        wikiUrl: null,
        sourceLookupSkipped: true,
      }
    }
  }
  try {
    return await withOfficial(await capture(plate))
  } catch (error) {
    const sources = await official
    if (sources.length) return { sources, wikiUrl: null }
    throw error
  }
}

/**
 * Build the local enrichment handler that synthesizes only eligible fields from captured
 * evidence.
 */
export function createEnrichmentHandler(options: {
  url: string
  fetch?: typeof fetch
  capture?: typeof captureEnrichment
  captureSaved?: typeof captureSavedEnrichment
}) {
  const request = options.fetch ?? fetch
  const capture = options.capture ?? captureEnrichment
  return async (
    input: {
      plate: WorkerPlate
      model?: string
      onPhase?: (index: number, skippedPhases?: number[]) => Promise<void>
    } & EnrichmentOptions
  ): Promise<StageResult> => {
    const choice =
      researchModel(input.model ?? 'desktop-gemma4-12b') ??
      researchModel(
        input.model === 'gemma4:26b'
          ? 'desktop-gemma4-26b'
          : input.model === 'gemma4:12b'
            ? 'desktop-gemma4-12b'
            : ''
      )
    if (!choice || choice.executor !== 'desktop')
      throw Error('Select an allowlisted desktop research model')
    const meta = {
      backend: 'ollama',
      model: choice.model,
      promptVersion: enrichmentPromptVersion,
    }
    const policy = input.policy ?? 'fill-missing'
    const plate = input.plate as Partial<Plate>
    const fields = enrichmentTargets(plate, policy)
    if (!fields.length) return { ...meta, stageError: 'no_supported_fields' }
    const { sources, wikiUrl, sourceLookupSkipped } = await prepareEnrichment(
      input.plate,
      input,
      {
        capture: (plate) => capture(plate, request),
        captureSaved: options.captureSaved,
      }
    )
    const skippedPhases = sourceLookupSkipped ? [0] : []
    if (!sources.length)
      return {
        ...meta,
        stageError: 'no_sources',
        ...(skippedPhases.length ? { skippedPhases } : {}),
      }
    let raw: unknown = wikiOnlyDraft(sources, wikiUrl)
    const usage: Record<string, number> = {}
    if (needsEnrichmentSynthesis(plate, policy)) {
      await input.onPhase?.(1, skippedPhases)
      const response = await request(
        `${options.url.replace(/\/+$/, '').replace(/\/v1$/, '')}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(180000),
          body: JSON.stringify({
            model: choice.model,
            stream: false,
            think: false,
            keep_alive: '30m',
            format: z.toJSONSchema(researchDraftSchema),
            options: { temperature: 0.1, num_ctx: 8192, num_predict: 1000 },
            messages: [
              {
                role: 'system',
                content:
                  'Return only the requested source-grounded research JSON draft.',
              },
              {
                role: 'user',
                content: enrichmentPrompt(input.plate, sources, policy, fields),
              },
            ],
          }),
        }
      )
      if (!response.ok)
        throw Error(`Local research model failed: ${response.status}`)
      const body = await response.json()
      if (typeof body.message?.content !== 'string')
        throw Error('Local research model returned no draft')
      raw = extractJson(body.message.content)
      for (const key of ['eval_count', 'prompt_eval_count'])
        if (
          typeof body[key] === 'number' &&
          Number.isFinite(body[key]) &&
          body[key] >= 0
        )
          usage[key] = body[key]
    } else skippedPhases.push(1)
    await input.onPhase?.(2, skippedPhases)
    // Deterministic Wiki matching survives even when synthesis supplies no text.
    if (raw && typeof raw === 'object')
      raw = {
        ...raw,
        wikiSource:
          (raw as { wikiSource?: unknown }).wikiSource ??
          wikiOnlyDraft(sources, wikiUrl).wikiSource,
      }
    const fieldSuggestion = enrichmentSuggestion(raw, sources, plate, policy)
    const researchNotes = skippedPhases.includes(1)
      ? []
      : enrichmentNotes(raw, sources, plate, policy)
    return {
      ...meta,
      ...(researchNotes.length ? { researchNotes } : {}),
      ...(fieldSuggestion
        ? { fieldSuggestion }
        : { stageError: 'no_supported_fields' as const }),
      usage,
      ...(skippedPhases.length ? { skippedPhases } : {}),
    }
  }
}
