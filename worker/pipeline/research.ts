import { z } from 'zod'
import type { Plate } from '../../lib/catalog/types'
import { enrichmentTargets, type EnrichmentPolicy } from '../../lib/research/enrichment'
import { enrichmentPrompt, enrichmentSuggestion, needsEnrichmentSynthesis, wikiOnlyDraft } from '../../lib/research/enrichment-result'
import { researchDraftSchema } from '../../lib/research/validate'
import { evidenceSource } from '../../lib/research/evidence'
import type { EvidenceSource } from '../../lib/research/types'
import { researchModel } from '../../lib/research/models'
import type { StageResult, WorkerPlate } from '../run'
import { gatherWikipedia } from './sources'
import { findWikipediaLink } from './wiki'
import { extractJson } from '../model'

export async function captureEnrichment(plate: WorkerPlate, request: typeof fetch = fetch): Promise<{ sources: EvidenceSource[]; wikiUrl: string | null }> {
  // Reuse the Wiki adapter's subject/jurisdiction match. The gather adapter then
  // fetches that page once, plus its bounded state/subject passages.
  const wiki = await findWikipediaLink(plate, request)
  const wikiUrl = wiki.fieldSuggestion?.kind === 'fields' ? wiki.fieldSuggestion.fields.wikiUrl ?? null : null
  const sources = await gatherWikipedia({ ...plate, wikiUrl: wikiUrl ?? plate.wikiUrl }, request)
  return { sources: sources.map(source => evidenceSource(source)), wikiUrl }
}

export function createEnrichmentHandler(options: { url: string; fetch?: typeof fetch; capture?: typeof captureEnrichment }) {
  const request = options.fetch ?? fetch
  return async (input: { plate: WorkerPlate; model?: string; policy?: EnrichmentPolicy }): Promise<StageResult> => {
    const choice = researchModel(input.model ?? 'desktop-gemma4-12b') ?? researchModel(input.model === 'gemma4:26b' ? 'desktop-gemma4-26b' : input.model === 'gemma4:12b' ? 'desktop-gemma4-12b' : '')
    if (!choice || choice.executor !== 'desktop') throw Error('Select an allowlisted desktop research model')
    const meta = { backend: 'ollama', model: choice.model, promptVersion: 'enrichment-v1' }
    const policy = input.policy ?? 'fill-missing'
    const plate = input.plate as Partial<Plate>
    const fields = enrichmentTargets(plate, policy)
    if (!fields.length) return { ...meta, stageError: 'no_supported_fields' }
    const { sources, wikiUrl } = await (options.capture ?? captureEnrichment)(input.plate, request)
    if (!sources.length) return { ...meta, stageError: 'no_sources' }
    let raw: unknown = wikiOnlyDraft(sources, wikiUrl)
    const usage: Record<string, number> = {}
    if (needsEnrichmentSynthesis(plate, policy)) {
      const response = await request(`${options.url.replace(/\/+$/, '').replace(/\/v1$/, '')}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000),
        body: JSON.stringify({ model: choice.model, stream: false, think: false, keep_alive: '30m', format: z.toJSONSchema(researchDraftSchema), options: { temperature: 0.1, num_ctx: 8192, num_predict: 1000 }, messages: [
          { role: 'system', content: 'Return only the requested source-grounded research JSON draft.' }, { role: 'user', content: enrichmentPrompt(input.plate, sources, policy, fields) },
        ] }) })
      if (!response.ok) throw Error(`Local research model failed: ${response.status}`)
      const body = await response.json()
      if (typeof body.message?.content !== 'string') throw Error('Local research model returned no draft')
      raw = extractJson(body.message.content)
      for (const key of ['eval_count', 'prompt_eval_count']) if (typeof body[key] === 'number' && Number.isFinite(body[key]) && body[key] >= 0) usage[key] = body[key]
    }
    // Deterministic Wiki matching survives even when synthesis supplies no text.
    if (raw && typeof raw === 'object') raw = { ...raw, wikiSource: (raw as { wikiSource?: unknown }).wikiSource ?? wikiOnlyDraft(sources, wikiUrl).wikiSource }
    const fieldSuggestion = enrichmentSuggestion(raw, sources, plate, policy)
    return { ...meta, ...(fieldSuggestion ? { fieldSuggestion } : { stageError: 'no_supported_fields' as const }), usage }
  }
}
