import { z } from 'zod'
import { emptyResearchDraft, type EvidenceSource, type ResearchDraft, type ResearchRejection } from './types'

export const researchDraftSchema = z.object({
  description: z.string().max(2000).nullable(),
  descriptionSources: z.array(z.string().max(100)).max(4),
  funFacts: z.array(z.object({ text: z.string().max(1000), sourceId: z.string().max(100) })).max(4),
  readMore: z.array(z.string().max(100)).max(4),
  wikiSource: z.string().max(100).nullable(),
}).strict()

const tokens = (text: string) => text.toLowerCase().match(/[a-z]{4,}|\d+/g) ?? []
const numbers = (text: string) => text.match(/\d[\d,.]*/g)?.map(value => value.replace(/[,.]/g, '')) ?? []
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

function supported(claim: string, sources: EvidenceSource[]) {
  const wanted = [...new Set(tokens(claim))]
  return sources.some(source => {
    const passages = source.text.split(/(?<=[.!?])\s+|\n+/)
    return passages.some((sentence, index) => {
      const text = sentence + ' ' + (passages[index + 1] ?? '')
      const have = new Set(tokens(text))
      return wanted.length > 0 && wanted.filter(token => have.has(token)).length / wanted.length >= 0.5 && numbers(claim).every(number => numbers(text).includes(number))
    })
  })
}

export function validateResearchResult(raw: unknown, sources: EvidenceSource[]): { draft: ResearchDraft; rejected: ResearchRejection[] } {
  const parsed = researchDraftSchema.safeParse(raw)
  const draft = emptyResearchDraft()
  const rejected: ResearchRejection[] = []
  if (!parsed.success) return { draft, rejected: [{ field: 'shape', reason: 'invalid_research_draft' }] }
  const data = parsed.data
  const lookup = (id: string) => sources.find(source => source.id === id)
  const descriptionSources = data.descriptionSources.flatMap(id => lookup(id) ?? [])
  if (data.description) {
    const sentences = data.description.split(/(?<=[.!?])\s+/).filter(Boolean)
    if (!descriptionSources.length || descriptionSources.length !== data.descriptionSources.length) rejected.push({ field: 'description', reason: 'source_not_fetched' })
    else if (words(data.description) < 10 || words(data.description) > 45 || sentences.length > 2) rejected.push({ field: 'description', reason: 'length' })
    else if (!sentences.every(claim => supported(claim, descriptionSources))) rejected.push({ field: 'description', reason: 'unsupported_claim' })
    else { draft.description = data.description.trim(); draft.descriptionSources = [...new Set(data.descriptionSources)] }
  }
  const seen = new Set<string>(draft.description ? [draft.description.toLowerCase().replace(/\W/g, '')] : [])
  for (const fact of data.funFacts) {
    const source = lookup(fact.sourceId)
    const key = fact.text.toLowerCase().replace(/\W/g, '')
    if (!source) rejected.push({ field: 'funFacts', reason: 'source_not_fetched' })
    else if (seen.has(key) || words(fact.text) < 5 || words(fact.text) > 25) rejected.push({ field: 'funFacts', reason: 'duplicate_or_length' })
    else if (!supported(fact.text, [source])) rejected.push({ field: 'funFacts', reason: 'unsupported_claim' })
    else { draft.funFacts.push({ text: fact.text.trim(), sourceId: fact.sourceId }); seen.add(key) }
  }
  draft.readMore = [...new Set(data.readMore.filter(id => {
    if (lookup(id)) return true
    rejected.push({ field: 'readMore', reason: 'source_not_fetched' })
    return false
  }))]
  if (data.wikiSource) {
    const source = lookup(data.wikiSource)
    if (source?.kind === 'wikipedia' && new URL(source.url).hostname === 'en.wikipedia.org') draft.wikiSource = source.id
    else rejected.push({ field: 'wikiUrl', reason: 'source_not_fetched' })
  }
  return { draft, rejected }
}
