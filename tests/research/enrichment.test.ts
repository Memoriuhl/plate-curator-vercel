import { expect, test } from 'vitest'
import {
  enrichmentFields,
  enrichmentTargets,
  filterEnrichmentFields,
} from '../../lib/research/enrichment'
import {
  enrichmentPrompt,
  enrichmentPromptVersion,
  enrichmentSuggestion,
} from '../../lib/research/enrichment-result'
import { evidenceSource } from '../../lib/research/evidence'
import { vi } from 'vitest'

test('Fill missing plans each field independently, treats blanks as missing, and skips populated plates', () => {
  const saved = {
    wikiUrl: 'https://en.wikipedia.org/wiki/Alaska',
    description: 'Saved',
    funFacts: [{ text: 'Saved', sourceUrl: 'https://example.org' }],
    readMore: [{ title: 'Saved', site: 'Example', url: 'https://example.org' }],
    firstIssuedYear: 1976,
  }
  expect(enrichmentTargets(saved, 'fill-missing')).toEqual([])
  expect(enrichmentTargets(saved, 'replace')).toEqual(enrichmentFields)
  expect(
    enrichmentTargets(
      { ...saved, description: '  ', funFacts: [] },
      'fill-missing'
    )
  ).toEqual(['description', 'funFacts'])
  expect(
    filterEnrichmentFields(
      { ...saved, description: 'Replacement', funFacts: [], readMore: [] },
      saved,
      'replace'
    )
  ).toEqual({
    wikiUrl: saved.wikiUrl,
    description: 'Replacement',
    firstIssuedYear: 1976,
  })
  expect(
    filterEnrichmentFields(
      {
        description: 'Proposed',
        funFacts: [{ text: 'New', sourceUrl: 'https://example.org' }],
      },
      saved,
      'fill-missing'
    )
  ).toEqual({})
})

test('Fill missing can add a cited issue year without overwriting existing facts or links', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  try {
    const source = evidenceSource({
      kind: 'wikipedia',
      url: 'https://en.wikipedia.org/wiki/Alaska',
      title: 'Alaska plates',
      text: 'The Alaska Wildlife registration plate was introduced in 1976.',
    })
    const suggestion = enrichmentSuggestion(
      {
        description: null,
        descriptionSources: [],
        funFacts: [],
        readMore: [],
        wikiSource: null,
        firstIssuedYear: { year: 1976, sourceId: source.id },
      },
      [source],
      {
        funFacts: [
          { text: 'Saved fact', sourceUrl: 'https://example.org/saved' },
        ],
        readMore: [
          {
            title: 'Saved link',
            site: 'Example',
            url: 'https://example.org/saved',
          },
        ],
      },
      'fill-missing'
    )
    expect(suggestion).toMatchObject({
      fields: { firstIssuedYear: 1976 },
      sources: [source.url],
    })
    expect(
      suggestion?.kind === 'fields' && Object.keys(suggestion.fields)
    ).toEqual(['firstIssuedYear'])
  } finally {
    vi.unstubAllEnvs()
  }
})

test('The enrichment prompt asks for the subject, not the plate, and ignores look-alike pages', () => {
  const prompt = enrichmentPrompt(
    { displayName: 'Taxi', state: 'AL' },
    [],
    'replace',
    ['description', 'funFacts']
  )
  expect(enrichmentPromptVersion).toBe('enrichment-v4')
  // Plate-framed descriptions fail claim matching, so the description describes the subject.
  expect(prompt).toContain('write about the subject, not the plate')
  expect(prompt).not.toContain('about the plate’s purpose or origin')
  // A page that only shares a word with the plate name (a band named Moon Taxi) is not evidence.
  expect(prompt).toContain(
    'Ignore evidence about anything else that merely shares a word with the plate name'
  )
  // Restating that the plate exists is not a fact, and citations stay out of the text.
  expect(prompt).toContain(
    'Saying that the plate exists, is listed, or is available'
  )
  expect(prompt).toContain(
    'Never put evidence IDs, brackets, or citations inside'
  )
})
