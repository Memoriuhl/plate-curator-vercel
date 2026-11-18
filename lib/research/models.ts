export const DEFAULT_HOSTED_RESEARCH_MODEL = 'google/gemini-2.5-flash-lite'
export const RESEARCH_MODELS = [
  { id: 'desktop-gemma4-12b', label: 'Gemma 4 12B', executor: 'desktop', model: 'gemma4:12b' },
  { id: 'desktop-gemma4-26b', label: 'Gemma 4 26B', executor: 'desktop', model: 'gemma4:26b' },
  { id: 'eve-gemini-2-5-flash-lite', label: 'Gemini 2.5 Flash Lite', executor: 'eve', model: DEFAULT_HOSTED_RESEARCH_MODEL },
] as const
export type ResearchModel = typeof RESEARCH_MODELS[number]
export function researchModel(id: unknown) { return RESEARCH_MODELS.find(model => model.id === id) ?? null }
export function allowedResearchModels(hosted: boolean, owner: boolean) { return RESEARCH_MODELS.filter(model => model.executor === 'desktop' || hosted && owner) }
export function resolveResearchModel(id: unknown, hosted: boolean, owner: boolean) {
  return allowedResearchModels(hosted, owner).find(model => model.id === (id ?? RESEARCH_MODELS[0].id)) ?? null
}
