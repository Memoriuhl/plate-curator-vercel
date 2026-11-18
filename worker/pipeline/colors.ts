import { COLORS, extractJson, ollamaChat } from '../model'
import { DEFAULT_TAGGING_MODEL, taggingModel, TAGGING_MODELS } from '../../lib/tagging/models'
import { parseFieldSuggestion } from '../../lib/jobs/suggestions'
import type { WorkerDeps } from '../run'

/** Normalize a model's color value through the supported palette. */
const color = (value: unknown) => typeof value === 'string' ? COLORS.find(color => color === value.trim().toLowerCase()) : undefined
const broad: Record<string, string> = { silver: 'gray', maroon: 'red', gold: 'yellow', tan: 'brown', navy: 'blue', teal: 'blue' }

/**
 * Build the color stage handler that proposes supported plate color fields with usage
 * metadata.
 */
export function createColorStageHandler(options: { url: string; fetch?: typeof fetch; readImage: (image: string) => Promise<string> }): NonNullable<WorkerDeps['suggestFields']> {
  return async ({ stage, plate, model: requested }) => {
    if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1' || stage !== 'colors') throw Error('Local Colors stage is unavailable')
    const model = requested ?? taggingModel(DEFAULT_TAGGING_MODEL)!.model
    if (!TAGGING_MODELS.some(choice => choice.runsOn === 'desktop' && choice.model === model)) throw Error('Select an enabled local model for Colors')
    const metadata = { backend: 'ollama', model, promptVersion: 'colors-v1' }
    const image = 'imageUrl' in plate && typeof plate.imageUrl === 'string' && plate.imageUrl ? plate.imageUrl : plate.image
    let imageB64: string
    try { imageB64 = await options.readImage(image) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...metadata, stageError: 'missing_image' }
      throw error
    }
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new Error('Local Colors inference deadline exceeded')), 120000)
    /**
     * Use the stage deadline for the model request and fail early when it has already
     * elapsed.
     */
    const request: typeof fetch = (url, init) => {
      deadline.signal.throwIfAborted()
      return (options.fetch ?? fetch)(url, { ...init, signal: deadline.signal })
    }
    const result = await (async () => {
      try { return await ollamaChat({ url: options.url, model, fetch: request }, { imageB64, plate }) }
      finally { clearTimeout(timer) }
    })()
    const raw = extractJson(result.text)
    const background = color(raw.primaryColor)
    if (!background) return { ...metadata, stageError: 'no_supported_fields' }
    const textColors = [...new Set((Array.isArray(raw.textColors) ? raw.textColors : []).flatMap(value => color(value) ?? []))]
    const tags = [...new Set([
      ...plate.tags.map(tag => tag.trim().toLowerCase()).filter(tag => !(tag.endsWith(' text') && color(tag.slice(0, -5)))),
      ...textColors.map(color => `${color} text`),
    ])]
    const fields = { colorDetail: background, lineageColor: broad[background] ?? background, ...(textColors.length && tags.length <= 50 ? { tags } : {}) }
    const fieldSuggestion = parseFieldSuggestion({ kind: 'fields', stage: 'colors', fields, sources: [] }, 'colors')
    return fieldSuggestion ? { ...metadata, fieldSuggestion, usage: result.usage } : { ...metadata, stageError: 'no_supported_fields' }
  }
}
