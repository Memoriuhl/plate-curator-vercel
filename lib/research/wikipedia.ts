import { createHash } from 'node:crypto'
import { evidenceSource } from './evidence'
import { readableText } from './fetch-page'
import type { EvidenceSource, ResearchInput } from './types'
import type { ResearchStateStore } from './state'

export type WikiDeps = {
  store: ResearchStateStore
  fetch: typeof fetch
  now(): number
  reserve(kind: 'wiki-search' | 'wiki-article'): Promise<boolean>
}

/** Read a bounded Wikipedia API response with caching and the run's request allowance. */
async function wikiRequest(
  params: Record<string, string>,
  kind: 'wiki-search' | 'wiki-article',
  deps: WikiDeps
) {
  const query = new URLSearchParams({
    ...params,
    format: 'json',
    formatversion: '2',
  })
  const key = `wiki/${createHash('sha256').update(query.toString()).digest('hex')}`
  const cached = await deps.store.read<{ at: number; data: unknown }>(key)
  if (cached && deps.now() - cached.at < 86400000)
    return cached.data as Record<string, unknown>
  if (!(await deps.reserve(kind)))
    throw new Error('Wikipedia research limit exhausted')
  const response = await deps.fetch(
    `https://en.wikipedia.org/w/api.php?${query}`,
    {
      headers: { 'User-Agent': 'PlateCuratorResearch/1.0' },
      signal: AbortSignal.timeout(10000),
    }
  )
  if (!response.ok)
    throw new Error(`Wikipedia request failed: ${response.status}`)
  const data = await response.json()
  await deps.store.update(key, () => ({
    value: { at: deps.now(), data },
    result: null,
  }))
  return data
}

/** Find matching Wikipedia articles and return titles with canonical evidence URLs. */
export async function searchWikipedia(
  query: string,
  deps: WikiDeps
): Promise<{ title: string; url: string }[]> {
  if (!query.trim() || query.length > 300)
    throw new Error('Invalid Wikipedia query')
  const data = (await wikiRequest(
    { action: 'query', list: 'search', srsearch: query, srlimit: '5' },
    'wiki-search',
    deps
  )) as { query?: { search?: { title: string }[] } }
  return (data.query?.search ?? []).map((row) => ({
    title: row.title,
    url:
      'https://en.wikipedia.org/wiki/' +
      encodeURIComponent(row.title.replaceAll(' ', '_')),
  }))
}

/**
 * Read one Wikipedia article and turn its readable text into a captured evidence record.
 */
export async function readWikipedia(
  title: string,
  deps: WikiDeps
): Promise<EvidenceSource | null> {
  if (!title.trim() || title.length > 300)
    throw new Error('Invalid Wikipedia title')
  const data = (await wikiRequest(
    { action: 'parse', page: title, prop: 'text|displaytitle', redirects: '1' },
    'wiki-article',
    deps
  )) as { parse?: { title?: string; text?: string } }
  if (!data.parse?.text) return null
  const text = readableText(data.parse.text)
  if (!text) return null
  const resolvedTitle = data.parse.title ?? title
  return evidenceSource(
    {
      kind: 'wikipedia',
      title: resolvedTitle,
      url:
        'https://en.wikipedia.org/wiki/' +
        encodeURIComponent(resolvedTitle.replaceAll(' ', '_')),
      text,
    },
    deps.now()
  )
}

/** Gather a bounded set of Wikipedia evidence from the search results. */
export async function gatherWikipedia(
  input: ResearchInput,
  deps: WikiDeps
): Promise<EvidenceSource[]> {
  const hits = await searchWikipedia(
    `${input.displayName} ${input.state} license plate`,
    deps
  )
  const sources: EvidenceSource[] = []
  for (const hit of hits.slice(0, 2)) {
    const source = await readWikipedia(hit.title, deps)
    if (source) sources.push(source)
  }
  return sources
}
