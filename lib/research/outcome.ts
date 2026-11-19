import type { Plate } from '../catalog/types'
import type {
  EvidenceSource,
  ResearchContentField,
  ResearchDraft,
  ResearchResult,
} from './types'

export const researchContentFields: readonly ResearchContentField[] = [
  'description',
  'funFacts',
]

/** List the content fields a plate still lacks, in a stable order. */
export function researchNeeds(
  plate: Partial<Pick<Plate, 'description' | 'funFacts'>>
): ResearchContentField[] {
  return researchContentFields.filter((field) =>
    field === 'description'
      ? !plate.description?.trim()
      : !plate.funFacts?.length
  )
}

/** Report whether a validated draft supplies one content field. */
function supplied(draft: ResearchDraft, field: ResearchContentField) {
  return field === 'description'
    ? Boolean(draft.description?.trim())
    : draft.funFacts.length > 0
}

/**
 * Judge a validated draft against the fields that were requested. A run that needed
 * nothing succeeds; otherwise it succeeds only when every requested field came back.
 * Jobs created before requests were recorded keep the original rule and need both.
 */
export function researchOutcome(
  draft: ResearchDraft,
  sources: readonly EvidenceSource[],
  requested: readonly ResearchContentField[] = researchContentFields
): {
  status: Extract<ResearchResult['status'], 'ok' | 'partial' | 'no_sources'>
  missing: ResearchContentField[]
} {
  const missing = requested.filter((field) => !supplied(draft, field))
  return {
    status: !requested.length
      ? 'ok'
      : !sources.length
        ? 'no_sources'
        : missing.length
          ? 'partial'
          : 'ok',
    missing,
  }
}
