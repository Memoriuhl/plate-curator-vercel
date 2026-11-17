import type { RunPlate } from './use-tag-run'

export const localStageReasons: Record<string, string> = {
  'Find image': 'Needs an image-search job and draft result',
  'Wiki link': 'Needs a reference-search job and draft result',
  Colors: 'Needs a color job and editable color fields',
  Describe: 'Needs a sourced description job and draft result',
  Story: 'Needs a sourced story job and draft result',
  Group: 'Needs a grouping job and family draft results',
  Order: 'No automatic ordering implementation',
}

export function planTagRun(plates: readonly RunPlate[], onlyUnderTagged: boolean, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) return []
  return plates.filter(plate => !onlyUnderTagged || plate.tags.length < 3).slice(0, limit)
}
