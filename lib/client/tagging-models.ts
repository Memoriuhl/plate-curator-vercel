import type { TaggingModel } from '../tagging/models'

export type TaggingModels = {
  models: Pick<TaggingModel, 'id' | 'label' | 'runsOn' | 'measured'>[]
  default: string | null
}

/** Format the tagging model label with its per-plate cost for selection controls. */
export function formatTaggingModel(model: TaggingModels['models'][number]) {
  const { costPerPlate } = model.measured
  const cost =
    costPerPlate === null ? 'free, local GPU' : '$' + costPerPlate + '/plate'
  return model.label + ' \u00b7 ' + cost
}
