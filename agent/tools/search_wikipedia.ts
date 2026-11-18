import { defineTool } from 'eve/tools'
import { z } from 'zod'

export default defineTool({
  description:
    'Find Wikipedia articles about the exact plate, its jurisdiction, or its subject. Returns article titles and URLs as leads. Read an article before citing its claims.',
  inputSchema: z.object({ query: z.string().min(1).max(300) }),
  /** Search Wikipedia for sources within the current research turn's request budget. */
  async execute({ query }, ctx) {
    const { researchTurn } = await import('../../lib/research/runtime')
    const { searchWikipedia } = await import('../../lib/research/wikipedia')
    const run = await researchTurn(ctx)
    return searchWikipedia(query, {
      store: run.store,
      now: Date.now,
      fetch,
      /** Reserve the Wikipedia search call before retrieving results. */ reserve:
        (kind) => run.reserve(kind),
    })
  },
})
