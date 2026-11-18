import { expect, test } from 'vitest'
import { runLegacyResearch } from '../../worker/research-legacy'

const input = {
  plateId: 'AZ.highways',
  displayName: 'Arizona Highways',
  state: 'AZ',
  inputRevision: 'plate-r1',
  baselineVersion: 14,
}
const source = {
  id: 'S1',
  kind: 'wikipedia',
  title: 'Arizona Highways',
  url: 'https://en.wikipedia.org/wiki/Arizona_Highways',
  text: 'Arizona Highways began as a highway department pamphlet in 1921.',
}
const outcome = {
  id: input.plateId,
  sources: [source],
  attempts: [
    { model: 'gemma4:12b', raw: { description: 'original' }, rejected: [] },
  ],
  draft: {
    description: 'A plate celebrating Arizona Highways magazine.',
    descriptionSource: source,
    funFacts: [{ text: 'The magazine began in 1921.', sourceUrl: source.url }],
    firstIssuedYear: null,
  },
  readMore: [{ title: source.title, url: source.url }],
  model: 'gemma4:12b',
  promptVersion: 'story-v2',
  status: 'ok' as const,
}

test('legacy research receives the captured identity and returns evidence-linked draft fields', async () => {
  let captured: unknown
  const result = await runLegacyResearch(
    input,
    {
      legacyRoot: '/fixture',
      model: 'gemma4:12b',
      expectedRevision: 'legacy-r1',
    },
    {
      /** Return the legacy repository revision expected by the research fixture. */
      revision: async () => 'legacy-r1',
      /**
       * Supply a fake legacy module so the adapter input can be inspected without loading
       * the game repository.
       */
      load: async () => ({
        /** Capture the plate sent to the legacy runner and return the fixture outcome. */ storyForPlate:
          async (plate) => {
            captured = plate
            return outcome
          },
      }),
      /** Pin the operation clock so timestamps and lease checks are reproducible. */
      now: () => 1000,
    }
  )
  expect(captured).toEqual({
    id: 'AZ.highways',
    displayName: 'Arizona Highways',
    state: 'AZ',
  })
  expect(result.draft.funFacts).toEqual([
    { text: 'The magazine began in 1921.', sourceId: 'S1' },
  ])
  expect(result.draft.readMore).toEqual(['S1'])
  expect(result.sources[0]).toMatchObject({
    id: 'S1',
    contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  expect(result.input.inputRevision).toBe('plate-r1')
  expect(result.provenance).toMatchObject({
    executor: 'desktop',
    codeRevision: 'legacy-r1',
    promptVersion: 'story-v2',
  })
  expect(result.cost.usd).toBeNull()
})

test('a changed baseline implementation is refused before loading model code', async () => {
  let loaded = false
  await expect(
    runLegacyResearch(
      input,
      { legacyRoot: '/fixture', model: 'gemma4:12b', expectedRevision: 'old' },
      {
        /** Return the legacy repository revision expected by the research fixture. */
        revision: async () => 'new',
        /** Detect any module load after legacy revision validation should already have stopped the run. */ load: async () => {
          loaded = true
          throw new Error('unexpected load')
        },
        /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
          0,
      }
    )
  ).rejects.toThrow('Legacy revision differs')
  expect(loaded).toBe(false)
})

test('citations absent from fetched evidence cannot become catalog links', async () => {
  const result = await runLegacyResearch(
    input,
    { legacyRoot: '/fixture', model: 'gemma4:12b', expectedRevision: 'r1' },
    {
      /** Return the legacy repository revision expected by the research fixture. */
      revision: async () => 'r1',
      /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
        0,
      /**
       * Provide a legacy outcome with an invented citation to exercise evidence
       * validation.
       */
      load: async () => ({
        /** Add an unsupported link to the fixture draft for the grounding test. */ storyForPlate:
          async () => ({
            ...outcome,
            draft: {
              ...outcome.draft,
              funFacts: [
                {
                  text: 'An unsupported fact.',
                  sourceUrl: 'https://example.com/invented',
                },
              ],
            },
          }),
      }),
    }
  )
  expect(result.draft.funFacts).toEqual([])
  expect(result.rejected).toContainEqual({
    field: 'funFacts',
    reason: 'source_not_fetched',
  })
})
