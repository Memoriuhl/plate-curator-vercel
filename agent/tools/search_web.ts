import { defineTool } from 'eve/tools'
import { z } from 'zod'

export default defineTool({
  description: 'Search existing Serper/Brave services when Wikipedia leaves a research question unanswered. Results are leads with snippets, provider, and cache status. Fetch promising pages with read_page before citing them. An unavailable or exhausted result means this search supplied no evidence.',
  inputSchema: z.object({ query: z.string().min(1).max(300) }),
  async execute({ query }, ctx) {
    const { researchTurn } = await import('../../lib/research/runtime')
    const { searchWeb } = await import('../../lib/research/search')
    const run = await researchTurn(ctx)
    return searchWeb(query, { store: run.store, now: Date.now, fetch, reserve: () => run.reserve('web-search'), keys: { serper: process.env.SERPER_API_KEY, brave: process.env.BRAVE_API_KEY } })
  },
})
