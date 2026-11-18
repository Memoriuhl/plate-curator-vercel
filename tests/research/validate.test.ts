import { expect, test } from 'vitest'
import { validateResearchResult } from '../../lib/research/validate'

const sources = [
  {
    id: 'S1',
    kind: 'web' as const,
    title: 'Wildlife plate',
    url: 'https://example.com/plate',
    text: 'The wildlife plate supports habitat protection across Arizona through funds collected from optional registration fees. The wildlife program began in 1987.',
    fetchedAt: '2026-11-17T00:00:00Z',
    contentHash: 'hash',
  },
]
const draft = {
  description:
    'The wildlife plate supports habitat protection across Arizona through optional registration fees.',
  descriptionSources: ['S1'],
  funFacts: [{ text: 'The wildlife program began in 1987.', sourceId: 'S1' }],
  readMore: ['S1'],
  wikiSource: null,
}

test('valid drafts resolve only fetched sources and preserve supported facts', () => {
  expect(validateResearchResult(draft, sources)).toMatchObject({
    draft,
    rejected: [],
  })
})

test('invented source IDs and unsupported numbers are rejected per field', () => {
  const result = validateResearchResult(
    {
      ...draft,
      descriptionSources: ['invented'],
      funFacts: [
        { text: 'The wildlife program began in 1999.', sourceId: 'S1' },
      ],
      readMore: ['invented'],
    },
    sources
  )
  expect(result.draft.description).toBeNull()
  expect(result.draft.funFacts).toEqual([])
  expect(result.draft.readMore).toEqual([])
  expect(result.rejected.map((value) => value.field)).toEqual(
    expect.arrayContaining(['description', 'funFacts', 'readMore'])
  )
})

test('empty evidence yields an empty draft rather than ungrounded prose', () => {
  const result = validateResearchResult(draft, [])
  expect(result.draft).toEqual({
    description: null,
    descriptionSources: [],
    funFacts: [],
    readMore: [],
    wikiSource: null,
  })
})

test('long or duplicate facts cannot inflate accepted coverage', () => {
  const result = validateResearchResult(
    {
      ...draft,
      funFacts: [
        ...draft.funFacts,
        ...draft.funFacts,
        { text: 'wildlife '.repeat(30), sourceId: 'S1' },
      ],
    },
    sources
  )
  expect(result.draft.funFacts).toHaveLength(1)
  expect(result.rejected).toContainEqual({
    field: 'funFacts',
    reason: 'duplicate_or_length',
  })
})
