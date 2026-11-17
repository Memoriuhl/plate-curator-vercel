import type { TaggingModel } from '../tagging/models'

export type TaggingModels = { models: Pick<TaggingModel, 'id' | 'label' | 'runsOn' | 'measured'>[]; default: string | null }

export function formatTaggingModel(model: TaggingModels['models'][number]) {
  const { f1, p50Seconds, costPerPlate } = model.measured
  const cost = costPerPlate === null ? 'free, local GPU' : '$' + costPerPlate + '/plate'
  return model.label + ' \u2014 F1 ' + f1.toFixed(2) + ' \u00b7 ~' + Math.round(p50Seconds) + ' s \u00b7 ' + cost
}
