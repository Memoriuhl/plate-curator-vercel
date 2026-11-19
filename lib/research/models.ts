export const DEFAULT_HOSTED_RESEARCH_MODEL = 'google/gemini-2.5-flash-lite'
export const RESEARCH_MODELS = [
  {
    id: 'desktop-gemma4-12b',
    label: 'Gemma 4 12B',
    executor: 'desktop',
    model: 'gemma4:12b',
  },
  {
    id: 'desktop-gemma4-26b',
    label: 'Gemma 4 26B',
    executor: 'desktop',
    model: 'gemma4:26b',
  },
  {
    id: 'eve-gemini-2-5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    executor: 'eve',
    model: DEFAULT_HOSTED_RESEARCH_MODEL,
  },
  {
    id: 'eve-gemma4-26b',
    label: 'Gemma 4 26B',
    executor: 'eve',
    model: 'google/gemma-4-26b-a4b-it',
  },
] as const
export type ResearchModel = (typeof RESEARCH_MODELS)[number]
/** Look up a configured research model by its stable identifier. */
export function researchModel(id: unknown) {
  return RESEARCH_MODELS.find((model) => model.id === id) ?? null
}
/** List research models available for the caller's deployment and owner access. */
export function allowedResearchModels(hosted: boolean, owner: boolean) {
  return RESEARCH_MODELS.filter(
    (model) => model.executor === 'desktop' || (hosted && owner)
  )
}
/** Resolve the requested model or a default from the models this caller can run. */
export function resolveResearchModel(
  id: unknown,
  hosted: boolean,
  owner: boolean
) {
  return (
    allowedResearchModels(hosted, owner).find(
      (model) => model.id === (id ?? RESEARCH_MODELS[0].id)
    ) ?? null
  )
}

export const CURATED_RESEARCH_MODELS = [
  DEFAULT_HOSTED_RESEARCH_MODEL,
  'google/gemma-4-26b-a4b-it',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3-flash',
  'anthropic/claude-haiku-5.5',
  'openai/gpt-5.4-nano',
  'alibaba/qwen3.8-flash',
  'amazon/nova-2-lite',
  'meta/llama-4-maverick',
  'mistral/mistral-small',
] as const
