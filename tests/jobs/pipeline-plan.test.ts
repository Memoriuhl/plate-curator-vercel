import { expect, test } from 'vitest'
import {
  orderedPipelineStages,
  planPipeline,
} from '../../lib/jobs/pipeline-plan'
import { snapshotPipelineOptions } from '../../lib/jobs/pipeline-options'

const plates = ['one', 'two'].map((slug) => ({
  id: `AK.${slug}`,
  state: 'AK',
  slug,
  displayName: slug,
  image: '',
  tags: [],
}))

test('selected dependency DAG orders Wiki before text and image/colors before Tag, with one scope Group after all individuals', () => {
  const selected = [
    'group',
    'tag',
    'story',
    'describe',
    'colors',
    'wiki-link',
    'find-image',
  ] as const
  const stages = orderedPipelineStages(selected)
  expect(stages).toEqual([
    'find-image',
    'wiki-link',
    'colors',
    'describe',
    'story',
    'tag',
    'group',
  ])
  const plan = planPipeline(
    plates,
    [...selected],
    snapshotPipelineOptions(selected, {})
  )
  expect(plan.filter((step) => step.stage === 'group')).toHaveLength(1)
  expect(plan.at(-1)?.stage).toBe('group')
  expect(
    plan
      .filter((step) => step.stage === 'colors')
      .every((step) => step.resourceClass === 'gpu')
  ).toBe(true)
  expect(
    plan
      .filter(
        (step) => step.stage === 'wiki-link' || step.stage === 'find-image'
      )
      .every((step) => step.resourceClass === 'io')
  ).toBe(true)
})

test('stage filters do not drop unrelated stages and default snapshots do not silently disable supported Group options', () => {
  const scope = [
    { ...plates[0], image: 'existing.webp', tags: ['one', 'two', 'three'] },
  ]
  const plan = planPipeline(scope, ['find-image', 'describe', 'tag'], {
    'find-image': { onlyMissingImage: true },
    tag: { onlyUnderTagged: true },
  })
  expect(plan.map((step) => step.stage)).toEqual(['describe'])
  expect(snapshotPipelineOptions(['group'], {})).toEqual({
    group: {
      method: 'embeddings',
      colorSignal: true,
      backgroundMask: false,
      visionTiebreak: false,
    },
  })
})

test('image enhancement follows a selected image search and keeps a standalone crop runnable', () => {
  const stages = ['enhance-image', 'find-image'] as const
  expect(orderedPipelineStages(stages)).toEqual(['find-image', 'enhance-image'])
  expect(
    planPipeline(plates.slice(0, 1), ['enhance-image'], {
      'enhance-image': { upscale: false, crop: true, roundCorners: false },
    })
  ).toMatchObject([{ stage: 'enhance-image', resourceClass: 'io' }])
})
