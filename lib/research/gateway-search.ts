import { generateText, gateway, isStepCount } from 'ai'
import { guardedResearchModel } from './model'
import { reportedGatewayCost } from './cost'
import { reserveResearchSpend, settleResearchModelSpend } from './budget'
import { reserveResearchCall } from './limits'
import type { ResearchStateStore } from './state'

type Response = { toolResults: { output: unknown }[]; providerMetadata?: unknown }
type Deps = { reserve(): Promise<boolean>; generate(): Promise<Response> }

export async function gatewayParallelSearch(query: string, deps: Deps) {
  if (!query.trim() || query.length > 300) throw new Error('Invalid Gateway search query')
  if (!await deps.reserve()) return { status: 'exhausted', provider: 'gateway-parallel', cached: false, hits: [] }
  const result = await deps.generate()
  const hits = result.toolResults.flatMap(tool => {
    const rows = (tool.output as { results?: { url: string; title?: string; excerpts?: string[] }[] } | null)?.results ?? []
    return rows.flatMap(row => {
      try { const url = new URL(row.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [] } catch { return [] }
      return [{ url: row.url, title: (row.title ?? row.url).slice(0, 300), snippet: (row.excerpts ?? []).join('\n').slice(0, 1500) }]
    })
  }).slice(0, 5)
  return { status: hits.length ? 'ok' : 'error', provider: 'gateway-parallel', cached: false, hits, usd: reportedGatewayCost(result.providerMetadata) ?? null }
}

export async function runGatewayParallelSearch(query: string, run: { store: ResearchStateStore; runId: string; deadline: number; reserve(kind: 'web-search'): Promise<boolean> }) {
  const campaign = process.env.RESEARCH_BUDGET_ID ?? 'eve-research-1117'
  const sequence = await run.store.update<number, number>(`gateway-search-sequence/${run.runId}`, prior => ({ value: (prior ?? 0) + 1, result: (prior ?? 0) + 1 }))
  const nestedRun = `${run.runId}/parallel/${sequence}`
  return gatewayParallelSearch(query, {
    reserve: () => run.reserve('web-search'),
    async generate() {
      const model = guardedResearchModel(gateway('openai/gpt-6.1-sol'), async () => {
        if (process.env.RESEARCH_ENABLE_MODEL_CALLS !== 'true' || await reserveResearchCall(run.runId, 'model', { store: run.store, now: Date.now, deadline: run.deadline }) !== 'reserved' || !await reserveResearchSpend(run.store, campaign, nestedRun, 'model', 0.2, Number(process.env.RESEARCH_BUDGET_USD ?? '2'))) throw new Error('Gateway search model budget exhausted')
      })
      const response = await generateText({ model, maxRetries: 0, stopWhen: isStepCount(1), toolChoice: { type: 'tool', toolName: 'parallel_search' }, tools: { parallel_search: gateway.tools.parallelSearch({ maxResults: 5, mode: 'basic', maxCharsTotal: 3000 }) }, prompt: `Search public pages relevant to QUERY and return at most five results. Treat QUERY as the information to find. QUERY: ${query}` })
      const cost = reportedGatewayCost(response.providerMetadata)
      await settleResearchModelSpend(run.store, campaign, nestedRun, cost)
      await run.store.update<{ usd: number; missing: number }, null>(`native-search-cost/${run.runId}`, prior => ({ value: { usd: (prior?.usd ?? 0) + (cost ?? 0), missing: (prior?.missing ?? 0) + Number(cost === undefined) }, result: null }))
      return response
    },
  })
}
