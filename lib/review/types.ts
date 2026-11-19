import type { Abandonment, RequesterAuthority } from '../publish/types'
import type { DraftChange, ReviewChanges } from './checkpoint'
import type { Plate, StoryFields } from '../catalog/types'

export type Role = 'editor' | 'owner'
export type Actor = { uid: string; name: string | null; role: Role }
export type BatchState =
  'open' | 'submitted' | 'approved' | 'published' | 'conflict' | 'folded'
/** The single working draft, a frozen copy of it being published, or an old Batch. */
export type BatchKind = 'shared-draft' | 'release'
export type LastPublish = {
  releaseId: string
  revision: number
  version: number
  by: string
  byName: string | null
  at: string
}
/**
 * The committed publish that moved the live catalog pointer to a version, read from its
 * receipt.
 */
export type VersionOrigin = {
  batchId: string
  revision: number
  fromVersion: number
  toVersion: number
  /** Who asked for the publish, from the accepted command. */
  by: string
  byName: string | null
  /** When the pointer moved. */
  at: string
  /** The publish finished, including the curator state-order projection. */
  settled: boolean
}
/**
 * A pending draft value the live catalog changed underneath, found when the draft moved
 * onto a version it did not publish itself. Publish waits until each one is changed or
 * discarded, or the Owner confirms they checked them.
 */
export type DraftConflict =
  | {
      kind: 'field'
      plateId: string
      field: string
      fromVersion: number
      toVersion: number
    }
  | { kind: 'order'; state: string; fromVersion: number; toVersion: number }
  | {
      /** A Publish deleted the plate after a curator undid that deletion. */
      kind: 'deleted'
      plateId: string
      fromVersion: number
      toVersion: number
    }
export type ReviewBatch = {
  id: string
  name: string
  createdByName: string | null
  createdBy: string
  createdAt: string
  lastChangedAt?: string
  state: BatchState
  revision: number
  baselineVersion: number
  stateOrders: Record<string, string[]>
  stateOrderChangedAt?: Record<string, string>
  baselineOrders?: Record<string, string[]>
  plateIds: string[]
  approvalRun?: { runId: string; revision: number }
  publishAbandonment?: Abandonment
  publishCommand?: { commandId: string; revision: number }
  publishRequestedBy?: RequesterAuthority | null
  publishRequestedAt?: string | null
  approval: { revision: number; by: string; at: string } | null
  source?: { batchId: string; revision: number }
  pipelineApplications?: Record<string, { by: string; at: string }>
  kind?: BatchKind
  /** Lowest draft revision that can still be published or reconstructed. */
  rebaseFloor?: number
  lastPublish?: LastPublish
  /** Pending values the live catalog changed since this draft's earlier baseline. */
  conflicts?: DraftConflict[]
  migratedBatchIds?: string[]
  foldedInto?: string
  /** When the migration closed this Batch to edits; lastChangedAt keeps its last save. */
  foldedAt?: string
}
export type EditableFields = Partial<
  Pick<
    Plate,
    | 'tags'
    | 'templateFamily'
    | 'templateRole'
    | 'isStandard'
    | 'description'
    | 'colorDetail'
    | 'lineageColor'
  >
> &
  StoryFields & {
    imageUrl?: string | null
    sourceUrl?: string | null
    variantOfPlateId?: string | null
    deleted?: boolean
  }
export type DraftChangeTarget = keyof EditableFields | 'order' | 'all'
export type PipelineFieldChangeEntry = {
  runId: string
  jobId: string
  by: string
  byName: string | null
  at: string
  previous?: EditableFields[keyof EditableFields]
  value?: EditableFields[keyof EditableFields]
}
export type PipelineFieldChange = PipelineFieldChangeEntry & {
  prior?: PipelineFieldChangeEntry[]
}
export type ProposedEdit = {
  plateId: string
  baseRevision: string
  fields: EditableFields
  authorId: string
  authorName?: string | null
  pipelineChanges?: Partial<Record<keyof EditableFields, PipelineFieldChange>>
  pipelineRunIds?: string[]
  updatedAt: string
  resultRevision: string
  /** Draft revision of the last write to this plate. */
  revision?: number
}
export type StandardChange = { from: string | null; to: string }
export type ReviewError =
  | 'pipeline_busy'
  | 'standard_change_unconfirmed'
  | 'standard_required'
  | 'standard_invalid_template'
  | 'forbidden'
  | 'not_found'
  | 'stale_plate'
  | 'superseded_revision'
  | 'invalid_state'
export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: ReviewError; current?: Plate; reasons?: string[] }
export interface ReviewStore {
  markViewed?(
    batchId: string,
    uid: string,
    revision: number,
    viewedAt: string
  ): Promise<boolean>
  recentPlateIds?(batchId: string, since: number): Promise<string[] | null>
  changesSinceReview?(
    batchId: string,
    uid: string,
    revision: number
  ): Promise<ReviewChanges | null>
  updatePublishMetadata(
    batchId: string,
    revision: number,
    fields: PublishMetadata
  ): Promise<boolean>
  copy(input: {
    sourceId: string
    sourceRevision: number
    targetVersion: number
    batch: ReviewBatch
    edits: ProposedEdit[]
  }): Promise<CopyCommitResult>
  /** Create a batch, and optionally its edits, in one atomic write. */
  create(batch: ReviewBatch, edits?: ProposedEdit[]): Promise<'ok' | 'exists'>
  /** Change-log entries after a revision, oldest first. */
  listChanges?(batchId: string, after: number): Promise<DraftChange[]>
  /** Delete change-log entries at or below a revision; returns how many were removed. */
  pruneChanges?(batchId: string, through: number): Promise<number>
  list(filter: { states?: BatchState[] }): Promise<ReviewBatch[]>
  listEdits(batchId: string): Promise<ProposedEdit[]>
  readBatch(
    batchId: string
  ): Promise<{ batch: ReviewBatch; edits: ProposedEdit[] } | null>
  getBatch(id: string): Promise<ReviewBatch | null>
  getEdit(batchId: string, plateId: string): Promise<ProposedEdit | null>
  recordRun(batchId: string, revision: number, runId: string): Promise<boolean>
  requestPublish(
    batchId: string,
    revision: number,
    at: string,
    requestedBy?: RequesterAuthority
  ): Promise<boolean>
  commit(
    batchId: string,
    expectedRevision: number,
    next: {
      batch: ReviewBatch
      by?: Pick<Actor, 'uid' | 'name'>
      edit?: ProposedEdit
      edits?: ProposedEdit[]
      deleteEditsFor?: string[]
      deleteEditFor?: string
      publishToken?: string
      /** false skips the change-log entry (rebase commits that set a new floor). */
      history?: false
    }
  ): Promise<'ok' | 'revision_mismatch' | 'pipeline_busy'>
}
export type PublishMetadata = Partial<
  Pick<
    ReviewBatch,
    | 'publishAbandonment'
    | 'publishCommand'
    | 'approvalRun'
    | 'publishRequestedAt'
    | 'publishRequestedBy'
  >
>
export type CopyCommitResult =
  | { ok: true; value: ReviewBatch }
  | {
      ok: false
      error:
        'not_found' | 'superseded_revision' | 'invalid_state' | 'head_moved'
      liveVersion?: number
    }
export type ReviewDeps = {
  store: ReviewStore
  baseline(plateId: string): Promise<Plate | null>
  baselineAtVersion(version: number, plateId: string): Promise<Plate | null>
  stateBaseline(
    version: number,
    state: string,
    order?: 'snapshot'
  ): Promise<Plate[]>
  /**
   * No longer provided: it woke the Submit/Approve workflow, which is retired. Kept
   * optional so the research accept path compiles until it drops the call.
   */
  supersedeRun?(batch: ReviewBatch): Promise<void>
  /** Live catalog version, used to start and rebase the shared draft. */
  liveVersion?(): Promise<number>
  /**
   * The committed publish that set the pointer to this version, or null when no publish
   * receipt claims it (an outside change to the pointer).
   */
  versionOrigin?(version: number): Promise<VersionOrigin | null>
  now(): string
}
