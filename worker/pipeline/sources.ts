import { JURISDICTIONS } from '../../lib/catalog/jurisdictions'
import type { WorkerPlate } from '../run'

export type Source = { id: string; kind: 'wikipedia' | 'web'; title: string; url: string; text: string }
const api = 'https://en.wikipedia.org/w/api.php'

export function standardPlateReference(plate: Pick<WorkerPlate, 'displayName' | 'state'>): string | undefined {
  const state = JURISDICTIONS[plate.state]
  if (state && /^\s*standard(?:\s*[-–—:]|\s*$)/i.test(plate.displayName)) return `Vehicle registration plates of ${state}`
}

function wikiTitle(value?: string | null) {
  try {
    const url = new URL(value ?? '')
    return url.protocol === 'https:' && url.hostname === 'en.wikipedia.org' && !url.username && !url.password && url.pathname.startsWith('/wiki/')
      ? decodeURIComponent(url.pathname.slice(6)).replaceAll('_', ' ') : null
  } catch { return null }
}

export function wikipediaText(html: string) {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<\/(tr|p|li|h[1-6])>/gi, '\n').replace(/<\/(td|th)>/gi, ' · ')
    .replace(/<[^>]+>/g, ' ').replace(/&(amp|quot|apos|nbsp|lt|gt);/g, (_match, key: string) => ({ amp: '&', quot: '"', apos: "'", nbsp: ' ', lt: '<', gt: '>' })[key]!)
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code: string) => { const value = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code); return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '' })
    .split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

export function relevantText(lines: string[], name: string) {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2 && !['plate', 'plates', 'standard', 'special', 'the', 'and'].includes(word))
  const relevant = words.length ? lines.filter(line => words.some(word => line.toLowerCase().includes(word))) : []
  const lead = lines.find(line => line.length > 100 && /\b(residents|registration|register|required|issued)\b/i.test(line))
  return [...new Set([...(lead ? [lead] : []), ...(relevant.length ? relevant : lines.filter(line => line.length > 80))])].slice(0, 6).join('\n').slice(0, 3000)
}

export async function gatherWikipedia(plate: WorkerPlate, request: typeof fetch = fetch): Promise<Source[]> {
  const query = (params: Record<string, string>) => wikipediaQuery(params, request)
  const titles = new Set<string>()
  const stateName = JURISDICTIONS[plate.state]
  const standardReference = standardPlateReference(plate)
  if (standardReference) {
    titles.add(standardReference)
  } else {
    const existing = wikiTitle(plate.wikiUrl)
    if (existing) titles.add(existing)
    if (stateName) titles.add(`Vehicle registration plates of ${stateName}`)
    const search = await query({ action: 'query', list: 'search', srsearch: `${plate.displayName} ${stateName ?? plate.state} license plate`, srlimit: '3' })
    const subjectWords = plate.displayName.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2 && !['plate', 'plates', 'standard', 'special', 'license', ...(stateName?.toLowerCase().split(' ') ?? [])].includes(word))
    for (const hit of search.query?.search ?? []) {
      if (typeof hit.title === 'string' && !/^(File|Category|Template|Special):|\((film|song|album|disambiguation|video game|novel)\)/i.test(hit.title) && subjectWords.some(word => hit.title.toLowerCase().includes(word))) titles.add(hit.title)
      if (titles.size >= 3) break
    }
  }
  const sources: Source[] = []
  for (const title of [...titles].slice(0, 3)) {
    let text: string
    let resolvedTitle: string
    if (/^Vehicle registration plates of /i.test(title)) {
      const body = await query({ action: 'parse', page: title, prop: 'text' })
      if (typeof body.parse?.text !== 'string') continue
      text = relevantText(wikipediaText(body.parse.text), plate.displayName)
      resolvedTitle = typeof body.parse.title === 'string' ? body.parse.title : title
    } else {
      const body = await query({ action: 'query', titles: title, prop: 'extracts', exintro: '1', explaintext: '1', exchars: '2000', redirects: '1' })
      const page = body.query?.pages?.find((page: { extract?: unknown }) => typeof page.extract === 'string' && page.extract)
      if (!page) continue
      text = page.extract.slice(0, 2000)
      resolvedTitle = typeof page.title === 'string' ? page.title : title
    }
    if (text.length < 80) continue
    sources.push({ id: `S${sources.length + 1}`, kind: 'wikipedia', title: resolvedTitle.slice(0, 200), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(resolvedTitle.replaceAll(' ', '_'))}`, text: text.slice(0, sources.length ? 1500 : 3000) })
  }
  return sources
}

export async function wikipediaQuery(params: Record<string, string>, request: typeof fetch = fetch) {
  const response = await request(`${api}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`, {
    headers: { 'User-Agent': 'PlateCuratorLocal/1.0 (source-backed catalog drafts)' }, signal: AbortSignal.timeout(20000), redirect: 'error',
  })
  if (!response.ok) throw new Error(`Wikipedia request failed: ${response.status}`)
  const text = await response.text()
  if (text.length > 2_000_000) throw new Error('Wikipedia response exceeded the source limit')
  return JSON.parse(text)
}
