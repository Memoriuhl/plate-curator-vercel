import type { RequesterAuthority } from '../publish/types'
import type { ReviewBatch } from './types'

export type ApprovalResult =
  | { outcome: 'published'; version: number; requestedBy?: RequesterAuthority }
  | { outcome: 'publish_failed'; error: string; reasons: string[]; requestedBy?: RequesterAuthority; reviewedVersion?: number; liveVersion?: number }
  | { outcome: 'superseded' | 'decision_timeout' | 'publish_timeout' }

export type RunStatus = {
  runId: string | null
  phase: 'waiting-for-approval' | 'waiting-for-publish' | 'publishing' | 'published' | 'failed' | 'superseded' | 'timed-out' | null
  outcome: { version?: number; error?: string; reasons?: string[]; requestedBy?: RequesterAuthority; reviewedVersion?: number; liveVersion?: number } | null
  updatedAt: string | null
}

export function approvalRunStatus(batch: ReviewBatch, run?: {
  status: string
  result?: ApprovalResult
  error?: string
  updatedAt: string | null
}): RunStatus {
  if (!batch.approvalRun) return { runId: null, phase: null, outcome: null, updatedAt: null }
  const status: RunStatus = { runId: batch.approvalRun.runId, phase: null, outcome: batch.publishRequestedBy ? { requestedBy: batch.publishRequestedBy } : null, updatedAt: run?.updatedAt ?? null }
  const result = run?.result
  if (result?.outcome === 'published') return { ...status, phase: 'published', outcome: { version: result.version, ...(result.requestedBy ? { requestedBy: result.requestedBy } : {}) } }
  if (result?.outcome === 'publish_failed') return { ...status, phase: 'failed', outcome: { error: result.error, reasons: result.reasons, ...(result.requestedBy ? { requestedBy: result.requestedBy } : {}), ...(result.reviewedVersion !== undefined ? { reviewedVersion: result.reviewedVersion, liveVersion: result.liveVersion } : {}) } }
  if (result?.outcome === 'superseded' || run?.status === 'cancelled') return { ...status, phase: 'superseded' }
  if (result?.outcome === 'decision_timeout' || result?.outcome === 'publish_timeout') return { ...status, phase: 'timed-out' }
  if (run?.status === 'failed') return { ...status, phase: 'failed', outcome: { error: run.error ?? 'Approval run failed', reasons: [] } }
  if (batch.state === 'open' || batch.state === 'conflict') return { ...status, phase: 'superseded' }
  if (batch.state === 'published') return { ...status, phase: 'publishing' }
  if (batch.state === 'submitted') return { ...status, phase: 'waiting-for-approval' }
  return { ...status, phase: batch.publishRequestedAt ? 'publishing' : 'waiting-for-publish', updatedAt: batch.publishRequestedAt ?? status.updatedAt }
}
