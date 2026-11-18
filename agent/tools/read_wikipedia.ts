import { defineTool } from 'eve/tools'
import { z } from 'zod'

export default defineTool({
  description:
    'Read a Wikipedia article by exact title and register its fetched passage as evidence. Cite the returned source ID only for claims stated in that passage.',
  inputSchema: z.object({ title: z.string().min(1).max(300) }),
  /** Read a Wikipedia article and save it as evidence the current draft can cite. */
  async execute({ title }, ctx) {
    const { researchTurn } = await import('../../lib/research/runtime')
    const { readWikipedia } = await import('../../lib/research/wikipedia')
    const run = await researchTurn(ctx)
    const source = await readWikipedia(title, {
      store: run.store,
      now: Date.now,
      fetch,
      /** Reserve a Wikipedia request against the current turn's tool allowance. */ reserve:
        (kind) => run.reserve(kind),
    })
    return source ? run.evidence(source) : { status: 'no_evidence' }
  },
})
