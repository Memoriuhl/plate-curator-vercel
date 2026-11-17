import { expect, test } from 'vitest'
import { DEFAULT_TAGGING_MODEL, TAGGING_MODELS, taggingModel } from '../../lib/tagging/models'

test('only tested models can be chosen', () => {
  expect(taggingModel('gateway-gemma4-26b')).toMatchObject({ runsOn: 'gateway', model: 'google/gemma-4-26b-a4b-it' })
  expect(taggingModel('desktop-gemma4-26b')).toMatchObject({ runsOn: 'desktop', model: 'gemma4:26b' })
  expect(taggingModel('openai/gpt-anything')).toBeNull()
  expect(taggingModel(undefined)).toBeNull()
  expect(taggingModel(DEFAULT_TAGGING_MODEL)?.runsOn).toBe('desktop')
  expect(new Set(TAGGING_MODELS.map(model => model.id)).size).toBe(TAGGING_MODELS.length)
})
