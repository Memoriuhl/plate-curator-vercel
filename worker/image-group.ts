import { createHash } from 'node:crypto'
import { DEFAULT_TAGGING_MODEL, taggingModel, TAGGING_MODELS } from '../lib/tagging/models'
import type { GroupRuntime, ImageGroupOptions } from '../lib/jobs/image-options'
import { parseGroupSuggestion, type GroupInput, type GroupSuggestion } from '../lib/jobs/specialized-suggestions'
import type { WorkerDeps } from './run'
import type { EmbeddingGroups } from './group-embedding'
import { findImage } from './find-image'
import { extractJson } from './model'
import { boundedResponse } from './remote-image'

export type GroupTiebreak = (a: GroupInput[number]['plate'], b: GroupInput[number]['plate'], model: string) => Promise<boolean>

/**
 * Translate predicted clusters into a validated regrouping proposal for the original
 * plate scope.
 */
export function groupProposal(scope: GroupInput, result: EmbeddingGroups, standardId?: string): GroupSuggestion | null {
  if (scope.length < 2 || scope.length > 25 || new Set(scope.map(member => member.plate.id)).size !== scope.length || new Set(scope.map(member => member.plate.state)).size !== 1) return null
  const members = new Map(scope.map(member => [member.plate.id, member]))
  const used = new Set<string>()
  const proposals = []
  for (const group of result.groups) {
    const ids = [group.templateId, ...group.variants.map(value => value.id)]
    if (ids.some(id => !members.has(id) || used.has(id)) || new Set(ids).size !== ids.length) return null
    ids.forEach(id => used.add(id))
    const anchor = standardId && ids.includes(standardId) ? standardId : group.templateId
    const family = anchor
    for (const id of ids) proposals.push({ plateId: id, baseRevision: members.get(id)!.baseRevision, fields: { templateFamily: family, templateRole: id === anchor ? 'template' : 'variant', variantOfPlateId: id === anchor ? null : anchor } })
  }
  if (used.size !== members.size) return null
  return parseGroupSuggestion({ kind: 'group', stage: 'group', scope: scope.map(member => ({ plateId: member.plate.id, baseRevision: member.baseRevision })), proposals, sources: [] })
}

/**
 * Run image grouping for the supplied stage, optionally resolving ambiguous pairs
 * through vision.
 */
export function createImageGroupRunner(deps: { fetch?: typeof fetch; embed?: (scope: GroupInput, options: ImageGroupOptions) => Promise<EmbeddingGroups>; runtime?: GroupRuntime; tiebreak?: GroupTiebreak }): NonNullable<WorkerDeps['suggestFields']> {
  return async ({ stage, plate, model: requested, options: rawOptions, groupScope, standardId }) => {
    if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1') throw new Error('Local pipeline is disabled')
    const options = rawOptions ?? {}
    if (stage === 'find-image') {
      const fieldSuggestion = await findImage(plate, { fetch: deps.fetch, onlyMissingImage: options.onlyMissingImage })
      return { backend: 'wikimedia-commons', model: 'commons-search', promptVersion: 'commons-raster-v1', ...(fieldSuggestion ? { fieldSuggestion } : { stageError: 'no_sources' as const }) }
    }
    if (stage !== 'group') throw new Error('Unsupported image/group stage')
    const metadata = { backend: 'local-cpu', model: 'dinov2_vits14', promptVersion: `legacy-cc-085-mask${Number(!!options.backgroundMask)}-color${Number(!!options.colorSignal)}-tie${Number(!!options.visionTiebreak)}` }
    if (options.method !== undefined && options.method !== 'embeddings' || !deps.embed || deps.runtime && (!deps.runtime.embeddings || (options.backgroundMask || options.colorSignal) && !deps.runtime.backgroundMask || options.visionTiebreak && !deps.runtime.visionTiebreak)) return { ...metadata, stageError: 'unavailable' }
    if (!groupScope || groupScope.length < 2) return { ...metadata, stageError: 'no_supported_fields' }
    if (options.visionTiebreak && !deps.tiebreak) return { ...metadata, stageError: 'unavailable' }
    const result = await deps.embed(groupScope, options)
    if (!Array.isArray(result.groups) || !Array.isArray(result.similarities) || result.similarities.length !== groupScope.length || result.similarities.some(row => row.length !== groupScope.length || row.some(value => !Number.isFinite(value) || value < -1.001 || value > 1.001))) throw new Error('Invalid embedding result')
    if (options.visionTiebreak && result.groups.length > 1) {
      const model = requested ?? taggingModel(DEFAULT_TAGGING_MODEL)!.model
      if (!TAGGING_MODELS.some(choice => choice.runsOn === 'desktop' && choice.model === model)) throw new Error('Select a local model for vision tiebreak')
      let pair: { a: number; b: number; score: number } | undefined
      for (let a = 0; a < result.groups.length; a++) for (let b = a + 1; b < result.groups.length; b++) {
        const ai = groupScope.findIndex(member => member.plate.id === result.groups[a].templateId)
        const bi = groupScope.findIndex(member => member.plate.id === result.groups[b].templateId)
        if (ai < 0 || bi < 0) throw new Error('Embedding result leaves the group scope')
        const score = result.similarities[ai][bi]
        if (score >= 0.8 && score < 0.85 && (!pair || score > pair.score)) pair = { a, b, score }
      }
      if (pair) {
        const a = result.groups[pair.a]
        const b = result.groups[pair.b]
        const left = groupScope.find(member => member.plate.id === a.templateId)!.plate
        const right = groupScope.find(member => member.plate.id === b.templateId)!.plate
        if (await deps.tiebreak!(left, right, model)) {
          a.variants.push({ id: b.templateId }, ...b.variants)
          result.groups.splice(pair.b, 1)
        }
      }
    }
    const fieldSuggestion = groupProposal(groupScope, result, standardId)
    if (!fieldSuggestion) throw new Error('Embedding groups do not cover the requested scope')
    return { ...metadata, fieldSuggestion }
  }
}

const tiebreakSystem = 'Compare these license plates by BASE DESIGN: the decorative background artwork and layout behind the serial. Ignore serial characters, minor lighting differences, vehicle format, and foreground organization emblems. Different background scenes/layouts are different designs. Reply JSON only: {"same_background":boolean,"confidence":number}.'

/**
 * Use the local vision model to decide whether an ambiguous plate pair matches with
 * sufficient confidence.
 */
export function localVisionTiebreak(deps: { url: string; readImage: (image: string) => Promise<string>; fetch?: typeof fetch }): GroupTiebreak {
  return async (a, b, model) => {
    const images = []
    for (const plate of [a, b]) images.push(await deps.readImage(typeof plate.imageUrl === 'string' && plate.imageUrl ? plate.imageUrl : plate.image))
    const response = await (deps.fetch ?? fetch)(`${deps.url.replace(/\/+$/, '').replace(/\/v1$/, '')}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45000),
      body: JSON.stringify({ model, stream: false, think: false, keep_alive: '10m', format: 'json', options: { temperature: 0.1, num_ctx: 4096, num_predict: 100 }, messages: [{ role: 'system', content: tiebreakSystem }, { role: 'user', content: `Plate A: ${a.displayName}. Plate B: ${b.displayName}. Are their base backgrounds the same?`, images }] }),
    })
    const body = JSON.parse((await boundedResponse(response, 128 * 1024)).toString())
    if (typeof body.message?.content !== 'string') throw new Error('Vision tiebreak returned no result')
    const decision = extractJson(body.message.content) as Record<string, unknown>
    return decision?.same_background === true && typeof decision.confidence === 'number' && decision.confidence >= 0.8 && decision.confidence <= 1
  }
}

export const groupTiebreakPromptVersion = createHash('sha256').update(tiebreakSystem).digest('hex').slice(0, 12)
