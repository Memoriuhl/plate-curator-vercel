export const LOCAL_STAGE_DEFINITIONS = [
  { label: 'Describe', stage: 'describe', needsModel: true },
  { label: 'Story', stage: 'story', needsModel: true },
  { label: 'Wiki link', stage: 'wiki-link', needsModel: false },
  { label: 'Colors', stage: 'colors', needsModel: true },
] as const

/**
 * Resolve a runnable local stage, including the legacy tagging stage supported by older
 * callers.
 */
export function runnableLocalStage(stage: unknown) {
  return (
    LOCAL_STAGE_DEFINITIONS.find((definition) => definition.stage === stage) ??
    (stage === 'find-image'
      ? { stage: 'find-image' as const, needsModel: true }
      : undefined)
  )
}
