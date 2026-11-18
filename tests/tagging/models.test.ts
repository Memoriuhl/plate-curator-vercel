import { expect, test } from 'vitest'
import {
  chooseTaggingModel,
  DEFAULT_TAGGING_MODEL,
  enabledTaggingModels,
  TAGGING_MODELS,
  taggingModel,
} from '../../lib/tagging/models'

test('only tested models can be chosen', () => {
  expect(taggingModel('gateway-gemma4-26b')).toMatchObject({
    runsOn: 'gateway',
    model: 'google/gemma-4-26b-a4b-it',
  })
  expect(taggingModel('desktop-gemma4-26b')).toMatchObject({
    runsOn: 'desktop',
    model: 'gemma4:26b',
  })
  expect(taggingModel('openai/gpt-anything')).toBeNull()
  expect(taggingModel(undefined)).toBeNull()
  expect(taggingModel(DEFAULT_TAGGING_MODEL)?.runsOn).toBe('desktop')
  expect(new Set(TAGGING_MODELS.map((model) => model.id)).size).toBe(
    TAGGING_MODELS.length
  )
})

test('gateway models stay off until the operator lists them', () => {
  expect(enabledTaggingModels(undefined).map((model) => model.runsOn)).toEqual([
    'desktop',
    'desktop',
  ])
  expect(
    enabledTaggingModels(' ').every((model) => model.runsOn === 'desktop')
  ).toBe(true)
  expect(
    enabledTaggingModels('gateway-gemma4-26b, desktop-gemma4-12b, nope').map(
      (model) => model.id
    )
  ).toEqual(['gateway-gemma4-26b', 'desktop-gemma4-12b'])
})

test('a Tag request gets an enabled model or a reason it cannot', () => {
  const desktopOnly = enabledTaggingModels(undefined)
  const all = enabledTaggingModels(
    TAGGING_MODELS.map((model) => model.id).join(',')
  )
  expect(chooseTaggingModel(undefined, desktopOnly)).toMatchObject({
    ok: true,
    model: { id: DEFAULT_TAGGING_MODEL },
  })
  expect(
    chooseTaggingModel(undefined, all, 'gateway-gemma4-26b')
  ).toMatchObject({ ok: true, model: { id: 'gateway-gemma4-26b' } })
  expect(
    chooseTaggingModel(undefined, desktopOnly, 'gateway-gemma4-26b')
  ).toMatchObject({ ok: true, model: { id: DEFAULT_TAGGING_MODEL } })
  expect(chooseTaggingModel('gateway-gemma4-26b', desktopOnly)).toEqual({
    ok: false,
    error: 'unavailable',
  })
  expect(chooseTaggingModel('gateway-gemma4-26b', all)).toMatchObject({
    ok: true,
    model: { runsOn: 'gateway' },
  })
  expect(chooseTaggingModel('openai/gpt-anything', all)).toEqual({
    ok: false,
    error: 'bad_request',
  })
  expect(chooseTaggingModel(undefined, [])).toEqual({
    ok: false,
    error: 'unavailable',
  })
})
