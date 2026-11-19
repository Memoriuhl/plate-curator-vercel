import { JURISDICTIONS } from '../catalog/jurisdictions'
import type { ResearchInput } from './types'

/**
 * Build the agent message identifying the exact plate, batch and revision to research.
 */
export function researchRequestMessage(input: ResearchInput) {
  // Older jobs did not record a request; they keep asking for both fields.
  const requested = input.requested ?? ['description', 'funFacts']
  const focus = requested.length
    ? `The plate lacks only: ${requested.join(', ')}. Spend the research on those fields; use null or an empty list for the others.`
    : 'The plate already has a description and facts. Return only links supported by the evidence.'
  return `Pipeline request: research the exact plate identified below. Gather source passages and finish with submit_draft, using only source IDs returned by the research tools. ${focus}\n${JSON.stringify({ plateId: input.plateId, displayName: input.displayName, jurisdiction: JURISDICTIONS[input.state] ?? input.state, inputRevision: input.inputRevision, requested })}`
}
