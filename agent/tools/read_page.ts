import { defineTool } from 'eve/tools'
import { z } from 'zod'

export default defineTool({
  description:
    'Fetch a public source page and register the readable passage as evidence. Use the final URL and source ID returned here for citations. A missing page supplies no evidence; exhaustion ends further page research for this run.',
  inputSchema: z.object({ url: z.string().url().max(2000) }),
  /** Fetch and save public page evidence under the current research turn's limits. */
  async execute({ url }, ctx) {
    const { researchTurn } = await import('../../lib/research/runtime')
    const { fetchResearchPage } = await import('../../lib/research/fetch-page')
    const run = await researchTurn(ctx)
    const source = await fetchResearchPage(url, {
      /** Charge the evidence read against the current turn's web page allowance. */ reserve:
        () => run.reserve('web-page'),
      now: Date.now,
    })
    return source ? run.evidence(source) : { status: 'no_evidence' }
  },
})
