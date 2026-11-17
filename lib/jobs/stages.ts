export const LOCAL_STAGE_DEFINITIONS = [
  { label: 'Describe', stage: 'describe', needsModel: true },
  { label: 'Story', stage: 'story', needsModel: true },
  { label: 'Wiki link', stage: 'wiki-link', needsModel: false },
  { label: 'Colors', stage: 'colors', needsModel: true },
] as const

export function runnableLocalStage(stage: unknown) {
  return LOCAL_STAGE_DEFINITIONS.find(definition => definition.stage === stage)
}
