import { afterEach, expect, test, vi } from 'vitest'
import { validateStory } from '../../worker/pipeline/validate'
import { createTextStageHandler } from '../../worker/pipeline/text'
import type { Source } from '../../worker/pipeline/sources'

afterEach(() => vi.unstubAllEnvs())
const source: Source = {
  id: 'S1',
  kind: 'wikipedia',
  title: 'Alaska registration plates',
  url: 'https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_Alaska',
  text: 'Alaska first issued this license plate in 1976. Its specialty program supports wildlife conservation projects across Alaska. The registration fees fund habitat restoration and protect local wildlife.',
}

test('legacy grounding rejects uncited facts, invented numbers and unsupported superlatives', () => {
  const result = validateStory(
    {
      description: null,
      firstIssuedYear: null,
      funFacts: [
        {
          text: 'The program supports wildlife conservation projects across Alaska.',
          source: 'missing',
        },
        {
          text: 'Registration fees fund 999 wildlife conservation projects across Alaska.',
          source: 'S1',
        },
        {
          text: 'The program supports the oldest wildlife conservation projects across Alaska.',
          source: 'S1',
        },
      ],
    },
    [source]
  )
  expect(result.draft.funFacts).toEqual([])
  expect(result.rejected).toHaveLength(3)
})

test('Describe uses supplied sources and the chosen local model, returning fields without catalog mutation', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      message: {
        content: JSON.stringify({
          description:
            'The registration fees fund habitat restoration and protect local wildlife across Alaska.',
          descriptionSource: 'S1',
          firstIssuedYear: null,
          funFacts: [],
        }),
      },
      eval_count: 20,
    })
  )
  const handler = createTextStageHandler({
    url: 'http://localhost:11434',
    fetch,
    /** Supply captured sources so the research test does not depend on live retrieval. */ gather:
      async () => [source],
  })
  const result = await handler({
    stage: 'describe',
    plate: { displayName: 'Wildlife', state: 'AK', image: '', tags: [] },
    model: 'gemma4:12b',
  })
  expect(result.fieldSuggestion).toMatchObject({
    stage: 'describe',
    fields: { description: expect.stringContaining('habitat restoration') },
    sources: [source.url],
  })
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
    model: 'gemma4:12b',
    stream: false,
    think: false,
    options: { num_ctx: 4096 },
  })
})

test('Story maps fetched citation IDs to source URLs and keeps only grounded facts and a supported year', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      message: {
        content: JSON.stringify({
          description: null,
          descriptionSource: null,
          firstIssuedYear: { year: 1976, source: 'S1' },
          funFacts: [
            {
              text: 'The program supports wildlife conservation projects across Alaska.',
              source: 'S1',
            },
          ],
        }),
      },
    })
  )
  const result = await createTextStageHandler({
    url: 'http://localhost:11434',
    fetch,
    /** Supply captured sources so the research test does not depend on live retrieval. */ gather:
      async () => [source],
  })({
    stage: 'story',
    plate: { displayName: 'Wildlife', state: 'AK', image: '', tags: [] },
    model: 'gemma4:12b',
  })
  expect(result.fieldSuggestion).toMatchObject({
    kind: 'fields',
    fields: {
      firstIssuedYear: 1976,
      funFacts: [{ text: expect.any(String), sourceUrl: source.url }],
      readMore: [{ url: source.url }],
    },
  })
})

test('missing sources stop before model inference', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const fetch = vi.fn<typeof globalThis.fetch>()
  await expect(
    createTextStageHandler({
      url: 'http://localhost:11434',
      fetch,
      /** Supply captured sources so the research test does not depend on live retrieval. */ gather:
        async () => [],
    })({
      stage: 'story',
      plate: { displayName: 'Unknown', state: 'AK', image: '', tags: [] },
      model: 'gemma4:12b',
    })
  ).resolves.toMatchObject({ stageError: 'no_sources' })
  expect(fetch).not.toHaveBeenCalled()
})

test('Story returns no result when every proposed fact is rejected', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      message: {
        content: JSON.stringify({
          firstIssuedYear: null,
          funFacts: [
            {
              text: 'An invented fact with no fetched citation.',
              source: 'missing',
            },
          ],
        }),
      },
    })
  )
  const result = await createTextStageHandler({
    url: 'http://localhost:11434',
    fetch,
    /** Supply captured sources so the research test does not depend on live retrieval. */ gather:
      async () => [source],
  })({
    stage: 'story',
    plate: { displayName: 'Wildlife', state: 'AK', image: '', tags: [] },
  })
  expect(result).toMatchObject({ stageError: 'no_supported_fields' })
  expect(result.fieldSuggestion).toBeUndefined()
})

test('Story read-more links include only sources cited by retained facts or year', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const unused = { ...source, id: 'S2', url: 'https://example.org/unused' }
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      message: {
        content: JSON.stringify({
          firstIssuedYear: null,
          funFacts: [
            {
              text: 'The program supports wildlife conservation projects across Alaska.',
              source: 'S1',
            },
          ],
        }),
      },
    })
  )
  const result = await createTextStageHandler({
    url: 'http://localhost:11434',
    fetch,
    /** Supply captured sources so the research test does not depend on live retrieval. */ gather:
      async () => [source, unused],
  })({
    stage: 'story',
    plate: { displayName: 'Wildlife', state: 'AK', image: '', tags: [] },
  })
  const suggestion = result.fieldSuggestion
  if (suggestion?.kind !== 'fields')
    throw new Error('Expected field suggestion')
  expect(suggestion.fields.readMore?.map((link) => link.url)).toEqual([
    source.url,
  ])
})

test('a subject founding year cannot become the plate issue year', () => {
  const founding = {
    ...source,
    text: 'The wildlife organization was founded in 1976 to support habitat restoration.',
  }
  expect(
    validateStory(
      {
        description: null,
        firstIssuedYear: { year: 1976, source: 'S1' },
        funFacts: [],
      },
      [founding]
    ).draft.firstIssuedYear
  ).toBeNull()
})

test('a subject article cannot establish a plate funding relationship', () => {
  const subject = {
    ...source,
    text: 'The wildlife organization supports habitat restoration and wildlife conservation projects across Alaska.',
  }
  const result = validateStory(
    {
      description:
        'This plate supports habitat restoration and wildlife conservation projects across Alaska.',
      descriptionSource: 'S1',
      firstIssuedYear: null,
      funFacts: [],
    },
    [subject]
  )
  expect(result.draft.description).toBeNull()
  expect(result.rejected[0].reason).toBe(
    'plate purpose not stated in cited source'
  )
})
