import { createHash } from 'node:crypto'
import type { ResearchStateStore } from './state'

type Provider = 'serper' | 'brave'
type SearchHit = { title: string; url: string; snippet: string }
export type SearchOutcome = { status: 'ok' | 'unavailable' | 'capped' | 'error' | 'exhausted'; provider: Provider | null; cached: boolean; hits: SearchHit[] }
export type SearchDeps = { store: ResearchStateStore; now(): number; keys: Partial<Record<Provider, string>>; fetch: typeof fetch; reserve(): Promise<boolean>; primary?: Provider; caps?: Partial<Record<Provider, number>>; sleep?: (ms: number) => Promise<void> }

export async function searchWeb(query: string, deps: SearchDeps): Promise<SearchOutcome> {
  const normalized = query.trim().toLowerCase()
  if (!normalized || query.length > 300) throw new Error('Search query must contain 1–300 characters')
  let last: SearchOutcome = { status: 'unavailable', provider: null, cached: false, hits: [] }
  const order: Provider[] = deps.primary === 'brave' ? ['brave', 'serper'] : ['serper', 'brave']
  for (const provider of order) {
    const key = deps.keys[provider]
    if (!key) continue
    const cacheKey = `search/${provider}/${createHash('sha256').update(normalized).digest('hex')}`
    const cached = await deps.store.read<{ at: number; hits: SearchHit[] }>(cacheKey)
    if (cached && deps.now() - cached.at < 86400000) return { status: 'ok', provider, cached: true, hits: cached.hits }
    const now = deps.now()
    const month = new Date(now).toISOString().slice(0, 7)
    const cap = deps.caps?.[provider] ?? (provider === 'serper' ? 2500 : 2000)
    const reservation = await deps.store.update<{ month: string; count: number; nextAt: number }, number | null>(`search-usage/${provider}`, prior => {
      const value = prior?.month === month ? prior : { month, count: 0, nextAt: 0 }
      if (value.count >= cap) return { value, result: null }
      const at = Math.max(now, value.nextAt)
      return { value: { month, count: value.count + 1, nextAt: at + (provider === 'brave' ? 1100 : 0) }, result: at }
    })
    if (reservation === null) { last = { status: 'capped', provider, cached: false, hits: [] }; continue }
    if (!(await deps.reserve())) {
      await deps.store.update<{ month: string; count: number; nextAt: number }, null>(`search-usage/${provider}`, prior => ({ value: prior?.month === month ? { ...prior, count: Math.max(0, prior.count - 1) } : prior ?? { month, count: 0, nextAt: 0 }, result: null }))
      return { status: 'exhausted', provider, cached: false, hits: [] }
    }
    if (reservation > now) await (deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(reservation - now)
    try {
      const url = provider === 'serper' ? 'https://google.serper.dev/search' : `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`
      const response = await deps.fetch(url, provider === 'serper'
        ? { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query, num: 5 }), signal: AbortSignal.timeout(10000) }
        : { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
      if (!response.ok) return { status: 'error', provider, cached: false, hits: [] }
      const data = await response.json()
      const raw = provider === 'serper' ? data.organic : data.web?.results
      const hits: SearchHit[] = (Array.isArray(raw) ? raw : []).flatMap(row => {
        const url = provider === 'serper' ? row.link : row.url
        return typeof url === 'string' && /^https?:\/\//.test(url) ? [{ url, title: String(row.title ?? '').slice(0, 300), snippet: String(row.snippet ?? row.description ?? '').slice(0, 1500) }] : []
      }).slice(0, 5)
      await deps.store.update(cacheKey, () => ({ value: { at: deps.now(), hits }, result: null }))
      return { status: 'ok', provider, cached: false, hits }
    } catch { return { status: 'error', provider, cached: false, hits: [] } }
  }
  return last
}
