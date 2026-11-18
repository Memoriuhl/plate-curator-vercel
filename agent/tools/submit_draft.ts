import { defineTool } from 'eve/tools'
import { researchDraftSchema } from '../../lib/research/validate'

export default defineTool({
  description: 'Finish a research pipeline request with the supported description, facts, and source IDs. Supply null or empty lists for missing evidence. This stores a review draft and ends the turn; accepting catalog fields remains a separate curator action.',
  inputSchema: researchDraftSchema,
  endsTurn: true,
  /** Validate and persist the structured draft produced by the research agent. */
  async execute(input, ctx) {
    const { submitResearchDraft } = await import('../../lib/research/runtime')
    return submitResearchDraft(ctx, input)
  },
})
