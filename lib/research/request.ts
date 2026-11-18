import { JURISDICTIONS } from '../catalog/jurisdictions'
import type { ResearchInput } from './types'

/**
 * Build the agent message identifying the exact plate, batch and revision to research.
 */
export function researchRequestMessage(input: ResearchInput) {
  return `Pipeline request: research the exact plate identified below. Gather source passages and finish with submit_draft, using only source IDs returned by the research tools.\n${JSON.stringify({ plateId: input.plateId, displayName: input.displayName, jurisdiction: JURISDICTIONS[input.state] ?? input.state, inputRevision: input.inputRevision })}`
}
