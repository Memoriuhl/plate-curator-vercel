export type ResearchExecutor = 'desktop' | 'eve'
export type ResearchInput = { plateId: string; displayName: string; state: string; inputRevision: string; baselineVersion: number }
export type EvidenceSource = { id: string; kind: 'wikipedia' | 'web'; title: string; url: string; fetchedAt: string; contentHash: string; text: string }
export type ResearchDraft = { description: string | null; descriptionSources: string[]; funFacts: { text: string; sourceId: string }[]; readMore: string[]; wikiSource: string | null; firstIssuedYear?: { year: number; sourceId: string } | null }
export type ResearchRejection = { field: 'description' | 'funFacts' | 'readMore' | 'wikiUrl' | 'shape'; reason: string }
export type ResearchResult = {
  input: ResearchInput
  sources: EvidenceSource[]
  draft: ResearchDraft
  rejected: ResearchRejection[]
  provenance: { executor: ResearchExecutor; model: string; promptVersion: string; codeRevision: string }
  attempts: unknown[]
  durationMs: number
  status: 'ok' | 'partial' | 'no_sources' | 'failed' | 'exhausted'
  cost: { usd: number | null; missing: number }
  counters: Record<string, number>
  cache: 'fresh' | 'cached' | 'mixed' | 'unknown'
}
export type ResearchState = 'queued' | 'running' | 'completed' | 'failed' | 'expired' | 'superseded'
export type ResearchJob = {
  id: string; requestKey: string; batchId: string; requestedBy: string; env: string
  input: ResearchInput; executor: ResearchExecutor; model: string; state: ResearchState
  createdAt: number; deadline: number; counters: Record<string, number>
  claim?: { id: string; workerId: string; expiresAt: number }
  eve?: { sessionId: string; deliveryId: string }
  dispatchStartedAt?: number
  result?: ResearchResult
  error?: string
  replacedBy?: string
  completedAt?: number
  acceptedRevision?: string
  acceptedFields?: string[]
  legacyRevision?: string
}

/** Create an empty research draft with the defaults expected by the validator and UI. */
export const emptyResearchDraft = (): ResearchDraft => ({ description: null, descriptionSources: [], funFacts: [], readMore: [], wikiSource: null })
