import { minimumPlateTagCount } from '@/lib/catalog/plate-checks'
import type { RunPlate } from './use-tag-run'

export const localStageReasons: Record<string, string> = {
  'Find image': 'Run selection needs the connected run coordinator',
  Group: 'Run selection needs the connected run coordinator',
  Order: 'Order is manual: drag families to reorder',
}

export function planTagRun(plates: readonly RunPlate[], onlyUnderTagged: boolean, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) return []
  return plates.filter(plate => !onlyUnderTagged || plate.tags.length < minimumPlateTagCount).slice(0, limit)
}
