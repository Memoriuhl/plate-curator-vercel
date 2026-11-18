import { JURISDICTIONS } from '../../lib/catalog/jurisdictions'
import { parseFieldSuggestion } from '../../lib/jobs/suggestions'
import type { StageResult, WorkerPlate } from '../run'
import { standardPlateReference, wikipediaQuery } from './sources'

export async function findWikipediaLink(plate: WorkerPlate, request: typeof fetch = fetch): Promise<StageResult> {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1') throw Error('Local Wikipedia lookup is unavailable')
  const metadata = { backend: 'wikipedia', model: 'wikipedia-search', promptVersion: 'wiki-link-v2' }
  const state = JURISDICTIONS[plate.state]
  const standardReference = standardPlateReference(plate)
  let title: string | null = null
  if (!standardReference) {
    const body = await wikipediaQuery({ action: 'query', list: 'search', srsearch: `${plate.displayName} ${state ?? plate.state}`, srlimit: '5' }, request)
    const words = plate.displayName.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2 && !['the', 'and', 'plate', 'plates', ...(state?.toLowerCase().split(' ') ?? [])].includes(word))
    const hits = (body.query?.search ?? []).filter((hit: { title?: unknown }) => typeof hit.title === 'string' && !/^(File|Category|Template|Special):|^(list|bibliography) of |\((film|song|album|disambiguation|video game|novel)\)/i.test(hit.title)) as { title: string }[]
    const ranked = hits.map(hit => ({ ...hit, score: words.length ? words.filter(word => hit.title.toLowerCase().includes(word)).length / words.length : 0 })).sort((a, b) => b.score - a.score)
    if (ranked[0]?.score >= (words.length <= 2 ? 1 : 0.75)) title = ranked[0].title
  }
  if (!title && state) {
    const fallback = await wikipediaQuery({ action: 'query', prop: 'info', titles: standardReference ?? `Vehicle registration plates of ${state}`, redirects: '1' }, request)
    title = fallback.query?.pages?.find((page: { missing?: boolean; title?: unknown }) => !page.missing && typeof page.title === 'string')?.title ?? null
  }
  if (!title) return { ...metadata, stageError: 'no_sources' }
  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`
  const fieldSuggestion = parseFieldSuggestion({ kind: 'fields', stage: 'wiki-link', fields: { wikiUrl: url }, sources: [url] }, 'wiki-link')
  return fieldSuggestion ? { ...metadata, fieldSuggestion } : { ...metadata, stageError: 'no_sources' }
}
