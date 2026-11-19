import type { HostedModelBinding } from '../models/selection'
export type ResearchExecutor = 'desktop' | 'eve'
/** Content a research run can supply; success is judged against the requested subset. */
export type ResearchContentField = 'description' | 'funFacts'
export type ResearchInput = {
  plateId: string
  displayName: string
  state: string
  inputRevision: string
  baselineVersion: number
  /** Fields the plate lacked when the job started. Older jobs omit it and need both. */
  requested?: ResearchContentField[]
}
export type EvidenceSource = {
  id: string
  kind: 'wikipedia' | 'web'
  title: string
  url: string
  fetchedAt: string
  contentHash: string
  text: string
}
export type ResearchDraft = {
  description: string | null
  descriptionSources: string[]
  funFacts: { text: string; sourceId: string }[]
  readMore: string[]
  wikiSource: string | null
  firstIssuedYear?: { year: number; sourceId: string } | null
}
export type ResearchRejection = {
  field: 'description' | 'funFacts' | 'readMore' | 'wikiUrl' | 'shape'
  reason: string
}
export type ResearchResult = {
  input: ResearchInput
  sources: EvidenceSource[]
  draft: ResearchDraft
  rejected: ResearchRejection[]
  provenance: {
    executor: ResearchExecutor
    model: string
    servedByFallback?: true
    promptVersion: string
    codeRevision: string
  }
  attempts: unknown[]
  durationMs: number
  status: 'ok' | 'partial' | 'no_sources' | 'failed' | 'exhausted'
  /** Requested fields the result did not supply. */
  missing?: ResearchContentField[]
  cost: { usd: number | null; missing: number }
  counters: Record<string, number>
  cache: 'fresh' | 'cached' | 'mixed' | 'unknown'
}
export type ResearchState =
  'queued' | 'running' | 'completed' | 'failed' | 'expired' | 'superseded'
export type ResearchJob = {
  id: string
  requestKey: string
  batchId: string
  requestedBy: string
  env: string
  input: ResearchInput
  executor: ResearchExecutor
  model: string
  hostedModel?: HostedModelBinding
  state: ResearchState
  createdAt: number
  deadline: number
  counters: Record<string, number>
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
export const emptyResearchDraft = (): ResearchDraft => ({
  description: null,
  descriptionSources: [],
  funFacts: [],
  readMore: [],
  wikiSource: null,
})
