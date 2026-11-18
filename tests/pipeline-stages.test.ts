import { expect, test } from 'vitest'
import { newRunStages, pipelineStages, stageAvailability } from '../components/dashboard/pipeline-stages'

test('registry exposes one stable id per stage, keeps legacy Tag available and manual Order disabled', () => {
  expect(new Set(pipelineStages.map(stage => stage.id)).size).toBe(pipelineStages.length)
  expect(pipelineStages.map(stage => stage.id)).toEqual(['research', 'find-image', 'enhance-image', 'wiki-link', 'colors', 'describe', 'story', 'tag', 'group', 'order'])
  expect(newRunStages.map(stage => stage.id)).toEqual(['research', 'find-image', 'enhance-image', 'tag', 'group'])
  for (const stage of pipelineStages) {
    if (stage.id === 'tag') expect(stageAvailability(stage, false)).toBeUndefined()
    else expect(stageAvailability(stage, false)).toBe('Coming soon')
  }
  const order = pipelineStages.find(stage => stage.id === 'order')!
  expect(order.jobKind).toBeNull()
  expect(stageAvailability(order, true)).toBe('Order is manual: drag families to reorder')
})
