import { expect, test, vi } from 'vitest'
import { prepareEnrichment } from '../../worker/pipeline/research'
import { enrichmentNotes } from '../../lib/research/enrichment-result'
import { parseResearchNotes } from '../../lib/research/enrichment'
import { evidenceSource } from '../../lib/research/evidence'
import type { Plate } from '../../lib/catalog/types'

const plate = (overrides: Partial<Plate>): Plate => ({
  id: 'HI.vietnam_veteran',
  slug: 'vietnam_veteran',
  state: 'HI',
  displayName: 'Vietnam Veteran',
  image: '',
  tags: [],
  description: 'Saved plate description',
  ...overrides,
})
const page = (url: string, text: string) =>
  evidenceSource({ kind: 'wikipedia', title: url, url, text })
const searched = page(
  'https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_Hawaii',
  'Hawaii issues a Vietnam Veteran license plate to qualified veterans of the Vietnam War.'
)

/** Run prepareEnrichment with a fixed saved page and a search stub. */
async function prepare(subject: Plate, saved: string) {
  const capture = vi.fn(async () => ({
    sources: [searched],
    wikiUrl: searched.url,
  }))
  const captureSaved = vi.fn(async () => ({
    sources: [page(subject.wikiUrl!, saved)],
    wikiUrl: subject.wikiUrl!,
  }))
  const fetchPage = vi.fn(async () => null)
  const result = await prepareEnrichment(
    subject,
    { policy: 'fill-missing' },
    { capture, captureSaved, fetchPage }
  )
  return { result, capture, captureSaved }
}

test('Fill missing keeps a saved subject page for a specialty plate', async () => {
  const { result, capture } = await prepare(
    plate({ wikiUrl: 'https://en.wikipedia.org/wiki/Vietnam_veteran' }),
    'A Vietnam veteran is a person who served in the armed forces during the Vietnam War.'
  )
  expect(capture).not.toHaveBeenCalled()
  expect(result.sourceLookupSkipped).toBe(true)
})

test('Fill missing searches for a Standard plate whose saved link is a generic article', async () => {
  const { result, capture } = await prepare(
    plate({
      id: 'HI.standard',
      displayName: 'Standard',
      wikiUrl: 'https://en.wikipedia.org/wiki/Standard',
    }),
    'Standard may refer to a standard plate, a flag, or a measure.'
  )
  expect(capture).toHaveBeenCalledOnce()
  expect(result.sourceLookupSkipped).toBeUndefined()
  expect(result.sources.map((source) => source.url)).toEqual([searched.url])
})

test('Fill missing reuses the state plates article saved on a Standard plate', async () => {
  const { result, capture } = await prepare(
    plate({
      id: 'HI.standard',
      displayName: 'Standard',
      wikiUrl:
        'https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_Hawaii',
    }),
    'The standard Hawaii plate shows a rainbow.'
  )
  expect(capture).not.toHaveBeenCalled()
  expect(result.sourceLookupSkipped).toBe(true)
})

test('research notes explain why description and story stayed unchanged', () => {
  const source = searched
  const subject = plate({ wikiUrl: null })
  const raw = {
    description:
      'Hawaii issues a Vietnam Veteran license plate to qualified veterans of the Vietnam War.',
    descriptionSources: [source.id],
    funFacts: [],
    readMore: [source.id],
    wikiSource: null,
  }
  expect(enrichmentNotes(raw, [source], subject, 'fill-missing')).toEqual([
    { field: 'description', reason: 'already_filled' },
    { field: 'funFacts', reason: 'not_found' },
  ])
  // Rejections from an earlier validation pass take precedence over "not found".
  expect(
    enrichmentNotes(
      { ...raw, description: null },
      [source],
      subject,
      'fill-missing',
      [{ field: 'funFacts', reason: 'unsupported_claim' }]
    )
  ).toEqual([{ field: 'funFacts', reason: 'unsupported_claim' }])
})

test('worker reports may only carry well-formed research notes', () => {
  expect(parseResearchNotes(undefined)).toEqual([])
  expect(
    parseResearchNotes([{ field: 'funFacts', reason: 'not_found' }])
  ).toEqual([{ field: 'funFacts', reason: 'not_found' }])
  expect(
    parseResearchNotes([{ field: 'tags', reason: 'not_found' }])
  ).toBeNull()
  expect(
    parseResearchNotes([{ field: 'funFacts', reason: 'whatever' }])
  ).toBeNull()
  expect(
    parseResearchNotes([{ field: 'funFacts', reason: 'not_found', extra: 1 }])
  ).toBeNull()
  expect(parseResearchNotes('notes')).toBeNull()
})
