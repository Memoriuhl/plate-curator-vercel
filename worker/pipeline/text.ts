import { createHash } from 'node:crypto'
import { JURISDICTIONS } from '../../lib/catalog/jurisdictions'
import {
  DEFAULT_TAGGING_MODEL,
  taggingModel,
  TAGGING_MODELS,
} from '../../lib/tagging/models'
import { parseFieldSuggestion } from '../../lib/jobs/suggestions'
import { extractJson } from '../model'
import type { WorkerDeps } from '../run'
import { gatherWikipedia, type Source } from './sources'
import { STORY_SCHEMA, STORY_SYSTEM, storyUserPrompt } from './prompt'
import { readMoreFrom, sourceFor, validateStory } from './validate'

/**
 * Build the local text stage handler that retrieves sources, prompts the model and
 * validates supported fields.
 */
export function createTextStageHandler(options: {
  url: string
  fetch?: typeof fetch
  gather?: typeof gatherWikipedia
  onRejected?: (reasons: string[]) => void
}): NonNullable<WorkerDeps['suggestFields']> {
  const request = options.fetch ?? fetch
  return async ({ stage, plate, model: requested }) => {
    if (
      process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1' ||
      !['describe', 'story'].includes(stage)
    )
      throw new Error('This local text stage is unavailable')
    const model = requested ?? taggingModel(DEFAULT_TAGGING_MODEL)!.model
    if (
      !TAGGING_MODELS.some(
        (choice) => choice.runsOn === 'desktop' && choice.model === model
      )
    )
      throw new Error('Select an enabled local model for this stage')
    const instruction =
      stage === 'describe'
        ? 'This run requests only the description. Return null for firstIssuedYear and an empty funFacts list.'
        : 'This run requests only sourced facts and a supported issue year. Return description and descriptionSource as null.'
    const metadata = {
      backend: 'ollama',
      model,
      promptVersion: createHash('sha256')
        .update(STORY_SYSTEM + instruction)
        .digest('hex')
        .slice(0, 12),
    }
    const sources: Source[] = await (options.gather ?? gatherWikipedia)(
      plate,
      request
    )
    if (!sources.length) return { ...metadata, stageError: 'no_sources' }
    const response = await request(
      `${options.url.replace(/\/+$/, '').replace(/\/v1$/, '')}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(180000),
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          keep_alive: '30m',
          format: STORY_SCHEMA,
          options: { temperature: 0.1, num_ctx: 4096, num_predict: 700 },
          messages: [
            { role: 'system', content: STORY_SYSTEM },
            {
              role: 'user',
              content: `${storyUserPrompt({ displayName: plate.displayName, stateName: JURISDICTIONS[plate.state] ?? plate.state, sources })}\n${instruction}`,
            },
          ],
        }),
      }
    )
    if (!response.ok)
      throw new Error(`Local text model failed: ${response.status}`)
    const body = await response.json()
    if (typeof body.message?.content !== 'string')
      throw new Error('Local text model returned no result')
    const raw = extractJson(body.message.content)
    const { draft, rejected } = validateStory(raw, sources)
    if (rejected.length)
      options.onRejected?.(
        rejected.map((item) => `${item.field}: ${item.reason}`)
      )
    const year = raw.firstIssuedYear
    const yearSource =
      draft.firstIssuedYear !== null && year && typeof year === 'object'
        ? sourceFor((year as { source?: unknown }).source, sources)
        : null
    const cited = sources.filter(
      (source) =>
        draft.funFacts.some((fact) => fact.sourceUrl === source.url) ||
        source === yearSource
    )
    const fields =
      stage === 'describe'
        ? draft.description
          ? { description: draft.description }
          : null
        : draft.funFacts.length || draft.firstIssuedYear !== null
          ? {
              ...(draft.funFacts.length ? { funFacts: draft.funFacts } : {}),
              ...(draft.firstIssuedYear !== null
                ? { firstIssuedYear: draft.firstIssuedYear }
                : {}),
              readMore: readMoreFrom(cited),
            }
          : null
    const fieldSuggestion =
      fields &&
      parseFieldSuggestion(
        {
          kind: 'fields',
          stage,
          fields,
          sources: sources.map((source) => source.url),
        },
        stage
      )
    if (!fieldSuggestion)
      return { ...metadata, stageError: 'no_supported_fields' }
    const usage: Record<string, number> = {}
    for (const key of ['eval_count', 'prompt_eval_count'])
      if (
        typeof body[key] === 'number' &&
        Number.isFinite(body[key]) &&
        body[key] >= 0
      )
        usage[key] = body[key]
    return { ...metadata, fieldSuggestion, usage }
  }
}
