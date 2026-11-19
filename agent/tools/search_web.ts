import { defineTool } from 'eve/tools'
import { z } from 'zod'

export default defineTool({
  description:
    'Search the configured web provider when Wikipedia leaves a research question unanswered. The standard configuration uses existing Serper/Brave services; benchmark variants may use Gateway Parallel search. Results are leads with snippets, provider, and cache status. Fetch promising pages with read_page before citing them. An unavailable or exhausted result means this search supplied no evidence.',
  inputSchema: z.object({ query: z.string().min(1).max(300) }),
  /** Search for web evidence through the provider configured for the current turn. */
  async execute({ query }, ctx) {
    const { researchTurn } = await import('../../lib/research/runtime')
    const { searchWeb } = await import('../../lib/research/sources/search')
    const run = await researchTurn(ctx)
    if (process.env.RESEARCH_SEARCH_PROVIDER === 'gateway-parallel') {
      const { runGatewayParallelSearch } =
        await import('../../lib/research/sources/gateway-search')
      return runGatewayParallelSearch(query, run)
    }
    return searchWeb(query, {
      store: run.store,
      now: Date.now,
      fetch,
      /** Reserve a web search before contacting the configured provider. */ reserve:
        () => run.reserve('web-search'),
      keys: {
        serper: process.env.SERPER_API_KEY,
        brave: process.env.BRAVE_API_KEY,
      },
    })
  },
})
