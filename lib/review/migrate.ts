import type { Plate } from '../catalog/types'
import {
  ensureDraft,
  newSharedDraft,
  orderOnto,
  sameList,
  sameLiveValue,
  trackedPlateIds,
  type DraftSnapshot,
} from './draft'
import { sharedDraftId } from './draft-id'
import { draftCommitAttempts, draftRetryPause } from './retry'
import { plateRevision } from './revision'
import { sameEditableValue } from './story'
import type {
  Actor,
  BatchState,
  EditableFields,
  PipelineFieldChange,
  ProposedEdit,
  ReviewBatch,
  ReviewDeps,
} from './types'

/** Why the migration will not write right now. */
export type MigrationBlock = 'publish_locked' | 'pipeline_busy'
export type MigrationOptions = {
  /** Write the result; without it the migration only reports what it would do. */
  apply: boolean
  actor: Pick<Actor, 'uid' | 'name'>
  /** Name a reason writing is unsafe now (a Publish or pipeline run), or null. */
  blocked?: () => Promise<MigrationBlock | null>
}
export type MigrationReport = {
  env: string
  draftId: string
  applied: boolean
  refused?: MigrationBlock | 'superseded_revision'
  /** Draft revision the fold was written at. */
  draftRevision: number | null
  /** Batches folded into the draft (or that would be, on a dry run), oldest first. */
  folded: string[]
  /** Batches left as they are, with the reason. */
  skipped: { id: string; state: BatchState; reason: string }[]
  /** Plates whose draft edit changes, naming the Batch each field's value came from. */
  plates: { plateId: string; fields: Record<string, string> }[]
  /** Plates whose draft edit goes away because the newest value is the live one. */
  removed: string[]
  /** States whose draft order changes, naming the Batch the order came from. */
  orders: Record<string, string>
  /** Fields and orders more than one source set differently. */
  conflicts: {
    plateId?: string
    field?: string
    state?: string
    winner: string
    losers: string[]
  }[]
  /**
   * Values a Batch saved against a catalog that has since published a different value
   * there. The published value stays; redo the change in the draft if it still matters.
   */
  kept: { batchId: string; plateId?: string; field?: string; state?: string }[]
  warnings: string[]
}

type Source = DraftSnapshot & { draft: boolean }
type Candidate<T> = {
  source: Source
  value: T
  stamp: string
  at: number
}
type FieldCandidate = Candidate<unknown> & {
  field: keyof EditableFields
  edit: ProposedEdit
}

const legacyStates: BatchState[] = ['open', 'submitted', 'approved']

/** A Batch from before the shared draft: no draft or release kind. */
const isLegacy = (batch: ReviewBatch) => !batch.kind

/** Milliseconds for an ISO time; unreadable times sort first. */
function time(value: string | undefined) {
  const parsed = Date.parse(value ?? '')
  return Number.isNaN(parsed) ? 0 : parsed
}

/** The newest candidate. Sources are ordered oldest Batch first and the draft last, so on a tie the later source (the draft) wins. */
function newest<T extends { at: number }>(candidates: T[]): T {
  return candidates.reduce((best, next) => (next.at >= best.at ? next : best))
}

/** Whether two orders put the plates they share in the same sequence. */
function sameSharedOrder(left: string[], right: string[]) {
  const shared = new Set(left.filter((id) => right.includes(id)))
  return sameList(
    left.filter((id) => shared.has(id)),
    right.filter((id) => shared.has(id))
  )
}

/** Distinct sources, other than the winner, that set a different value. */
function losers<T>(
  candidates: Candidate<T>[],
  winner: Candidate<T>,
  same: (left: T, right: T) => boolean
) {
  return [
    ...new Set(
      candidates
        .filter(
          (candidate) =>
            candidate !== winner && !same(candidate.value, winner.value)
        )
        .map((candidate) => candidate.source.batch.id)
    ),
  ]
}

/**
 * Work out the draft after folding the given Batches into it. Per field and per state
 * order the newest value wins, timed by the pipeline result's time when there is one,
 * else the edit's last save; the draft wins ties. A Batch value saved against a catalog
 * value that has since been published elsewhere does not compete: the published value
 * stays and the report lists it.
 */
async function foldPlan(
  d: ReviewDeps,
  head: DraftSnapshot,
  legacy: DraftSnapshot[],
  version: number
) {
  const sources: Source[] = [
    ...legacy.map((snapshot) => ({ ...snapshot, draft: false })),
    { ...head, draft: true },
  ]
  const plates = new Map<string, Promise<Plate | null>>()
  /** Read a catalog plate once per version. */
  const plateAt = (at: number, id: string) => {
    const key = `${at}:${id}`
    if (!plates.has(key)) plates.set(key, d.baselineAtVersion(at, id))
    return plates.get(key)!
  }
  const orders = new Map<string, Promise<string[]>>()
  /** Read a state's live order once. */
  const liveOrder = (state: string) => {
    if (!orders.has(state))
      orders.set(
        state,
        d
          .stateBaseline(version, state)
          .then((list) => list.map((plate) => plate.id))
      )
    return orders.get(state)!
  }
  const report: Pick<
    MigrationReport,
    'plates' | 'removed' | 'orders' | 'conflicts' | 'kept' | 'warnings'
  > = {
    plates: [],
    removed: [],
    orders: {},
    conflicts: [],
    kept: [],
    warnings: [],
  }

  const fieldCandidates = new Map<string, Map<string, FieldCandidate[]>>()
  const legacyPlates = new Set<string>()
  for (const source of sources) {
    for (const edit of source.edits) {
      const live = await plateAt(version, edit.plateId)
      if (!live) {
        if (!source.draft && !edit.fields.deleted)
          report.warnings.push(
            `Plate no longer in the catalog: ${edit.plateId} (from ${source.batch.id})`
          )
        continue
      }
      if (!source.draft) legacyPlates.add(edit.plateId)
      const base =
        source.draft || source.batch.baselineVersion === version
          ? live
          : await plateAt(source.batch.baselineVersion, edit.plateId)
      for (const [key, value] of Object.entries(edit.fields)) {
        if (value === undefined) continue
        const field = key as keyof EditableFields
        if (
          base &&
          !sameLiveValue(
            field,
            base[field as keyof Plate],
            live[field as keyof Plate]
          )
        ) {
          if (!sameLiveValue(field, value, live[field as keyof Plate]))
            report.kept.push({
              batchId: source.batch.id,
              plateId: edit.plateId,
              field,
            })
          continue
        }
        const stamp = edit.pipelineChanges?.[field]?.at ?? edit.updatedAt
        const byField = fieldCandidates.get(edit.plateId) ?? new Map()
        byField.set(field, [
          ...(byField.get(field) ?? []),
          { source, edit, field, value, stamp, at: time(stamp) },
        ])
        fieldCandidates.set(edit.plateId, byField)
      }
    }
  }

  const headEdits = new Map(head.edits.map((edit) => [edit.plateId, edit]))
  const edits: ProposedEdit[] = []
  for (const plateId of [...legacyPlates].sort()) {
    const live = (await plateAt(version, plateId))!
    const draftEdit = headEdits.get(plateId)
    const winners: FieldCandidate[] = []
    for (const [field, candidates] of fieldCandidates.get(plateId) ?? []) {
      const winner = newest(candidates)
      const lost = losers(candidates, winner, (left, right) =>
        sameEditableValue(field, left, right)
      )
      if (lost.length)
        report.conflicts.push({
          plateId,
          field,
          winner: winner.source.batch.id,
          losers: lost,
        })
      if (!sameLiveValue(field, winner.value, live[field as keyof Plate]))
        winners.push(winner)
    }
    const fields = Object.fromEntries(
      winners.map((winner) => [winner.field, winner.value])
    ) as EditableFields
    const unchanged =
      winners.every((winner) => winner.source.draft) &&
      winners.length === Object.keys(draftEdit?.fields ?? {}).length
    if (unchanged) continue
    if (!winners.length) {
      if (draftEdit) report.removed.push(plateId)
      continue
    }
    const top = newest(winners)
    const pipelineChanges = Object.fromEntries(
      winners.flatMap((winner) => {
        const change = winner.edit.pipelineChanges?.[winner.field]
        return change &&
          sameEditableValue(winner.field, change.value, winner.value)
          ? [[winner.field, change]]
          : []
      })
    ) as Partial<Record<keyof EditableFields, PipelineFieldChange>>
    const runIds = [
      ...new Set(Object.values(pipelineChanges).map((change) => change.runId)),
    ]
    const authorName =
      top.edit.authorName ??
      (top.edit.authorId === top.source.batch.createdBy
        ? top.source.batch.createdByName
        : null)
    edits.push({
      plateId,
      fields,
      authorId: top.edit.authorId,
      ...(authorName ? { authorName } : {}),
      updatedAt: top.stamp,
      baseRevision: plateRevision(live),
      resultRevision: plateRevision({ ...live, ...fields } as Plate),
      ...(runIds.length ? { pipelineChanges, pipelineRunIds: runIds } : {}),
    })
    report.plates.push({
      plateId,
      fields: Object.fromEntries(
        winners.map((winner) => [winner.field, winner.source.batch.id])
      ),
    })
  }

  const orderCandidates = new Map<string, Candidate<string[]>[]>()
  const legacyOrderStates = new Set<string>()
  for (const source of sources) {
    for (const [state, order] of Object.entries(
      source.batch.stateOrders ?? {}
    )) {
      if (!source.draft) {
        legacyOrderStates.add(state)
        const before = source.batch.baselineOrders?.[state]
        if (before && !sameSharedOrder(before, await liveOrder(state))) {
          report.kept.push({ batchId: source.batch.id, state })
          continue
        }
      }
      const stamp =
        source.batch.stateOrderChangedAt?.[state] ??
        source.batch.lastChangedAt ??
        source.batch.createdAt
      orderCandidates.set(state, [
        ...(orderCandidates.get(state) ?? []),
        { source, value: order, stamp, at: time(stamp) },
      ])
    }
  }
  const stateOrders = { ...head.batch.stateOrders }
  const baselineOrders = { ...head.batch.baselineOrders }
  const stateOrderChangedAt = { ...head.batch.stateOrderChangedAt }
  for (const state of [...legacyOrderStates].sort()) {
    const candidates = orderCandidates.get(state) ?? []
    if (!candidates.length) continue
    const winner = newest(candidates)
    const lost = losers(candidates, winner, sameList)
    if (lost.length)
      report.conflicts.push({
        state,
        winner: winner.source.batch.id,
        losers: lost,
      })
    if (winner.source.draft) continue
    const live = await liveOrder(state)
    if (!live.length) {
      report.warnings.push(
        `State no longer in the catalog: ${state} (from ${winner.source.batch.id})`
      )
      continue
    }
    const order = orderOnto(winner.value, live)
    report.orders[state] = winner.source.batch.id
    if (sameList(order, live)) {
      delete stateOrders[state]
      delete baselineOrders[state]
      delete stateOrderChangedAt[state]
      continue
    }
    stateOrders[state] = order
    baselineOrders[state] = live
    stateOrderChangedAt[state] = winner.stamp
  }

  const kept = [
    ...head.edits
      .map((edit) => edit.plateId)
      .filter((id) => !report.removed.includes(id)),
    ...edits.map((edit) => edit.plateId),
  ]
  const batch: ReviewBatch = {
    ...head.batch,
    revision: head.batch.revision + 1,
    lastChangedAt: d.now(),
    stateOrders,
    baselineOrders,
    stateOrderChangedAt,
    plateIds: trackedPlateIds(head.batch.plateIds, kept),
    migratedBatchIds: [
      ...(head.batch.migratedBatchIds ?? []),
      ...legacy.map((snapshot) => snapshot.batch.id),
    ],
    // The fold rewrites edits without change-log history, like a rebase.
    rebaseFloor: head.batch.revision + 1,
  }
  return { batch, edits, report }
}

/** Close a legacy Batch to edits and point it at the draft it is folded into. */
async function markFolded(d: ReviewDeps, id: string, draftId: string) {
  for (let attempt = 0; attempt < draftCommitAttempts; attempt += 1) {
    await draftRetryPause(attempt)
    const batch = await d.store.getBatch(id)
    if (!batch || !isLegacy(batch)) return false
    if (batch.state === 'folded') return batch.foldedInto === draftId
    if (!legacyStates.includes(batch.state)) return false
    const result = await d.store.commit(id, batch.revision, {
      batch: {
        ...batch,
        state: 'folded',
        foldedInto: draftId,
        revision: batch.revision + 1,
        // lastChangedAt stays: it times this Batch's state orders in the fold.
        foldedAt: d.now(),
      },
      history: false,
    })
    if (result === 'ok') return true
    if (result !== 'revision_mismatch') return false
  }
  return false
}

/**
 * One-time move from per-person Batches to the environment's shared draft. Open,
 * submitted and approved Batches are closed as `folded` and their values merged into the
 * draft; published Batches stay as history and conflicted ones are left alone.
 *
 * Batches are marked before the draft is written so nobody edits them mid-fold, and the
 * draft records which Batches it has taken in, so a run stopped halfway finishes on the
 * next run and a repeat run changes nothing.
 */
export async function migrateToSharedDraft(
  d: ReviewDeps,
  env: string,
  options: MigrationOptions
): Promise<MigrationReport> {
  const draftId = sharedDraftId(env)
  const report: MigrationReport = {
    env,
    draftId,
    applied: false,
    draftRevision: null,
    folded: [],
    skipped: [],
    plates: [],
    removed: [],
    orders: {},
    conflicts: [],
    kept: [],
    warnings: [],
  }
  if (options.apply) {
    const blocked = await options.blocked?.()
    if (blocked) return { ...report, refused: blocked }
  }
  if (!d.liveVersion) throw new Error('Live catalog version unavailable')
  const version = await d.liveVersion()
  report.skipped = (await d.store.list({ states: ['conflict'] }))
    .filter(isLegacy)
    .map((batch) => ({
      id: batch.id,
      state: batch.state,
      reason: 'conflict: resolve it in the old Batch view',
    }))
  if (options.apply) {
    await ensureDraft(d, env, options.actor)
    const open = (await d.store.list({ states: legacyStates })).filter(isLegacy)
    for (const batch of open)
      if (!(await markFolded(d, batch.id, draftId)))
        report.skipped.push({
          id: batch.id,
          state: batch.state,
          reason: 'could not close it to edits',
        })
  }

  for (let attempt = 0; attempt < draftCommitAttempts; attempt += 1) {
    await draftRetryPause(attempt)
    const stored = await d.store.readBatch(draftId)
    if (!stored && options.apply) throw new Error('Shared draft unavailable')
    const head = stored ?? {
      batch: newSharedDraft(env, version, options.actor, d.now()),
      edits: [],
    }
    const warnings =
      head.batch.baselineVersion === version
        ? []
        : [
            `The draft moves from Catalog v${head.batch.baselineVersion} to v${version} before the fold`,
          ]
    const migrated = new Set(head.batch.migratedBatchIds ?? [])
    const pending = (
      await d.store.list({
        states: options.apply ? ['folded'] : [...legacyStates, 'folded'],
      })
    )
      .filter(
        (batch) =>
          isLegacy(batch) &&
          !migrated.has(batch.id) &&
          (batch.state !== 'folded' || batch.foldedInto === draftId)
      )
      .sort(
        (left, right) =>
          time(left.createdAt) - time(right.createdAt) ||
          left.id.localeCompare(right.id)
      )
    const sources = (
      await Promise.all(pending.map((batch) => d.store.readBatch(batch.id)))
    ).filter((snapshot): snapshot is DraftSnapshot => !!snapshot)
    const plan = await foldPlan(d, head, sources, version)
    const result: MigrationReport = {
      ...report,
      ...plan.report,
      warnings: [...warnings, ...plan.report.warnings],
      folded: sources.map((snapshot) => snapshot.batch.id),
      applied: options.apply,
      draftRevision: stored?.batch.revision ?? null,
    }
    if (!options.apply || !sources.length) return result
    const outcome = await d.store.commit(draftId, head.batch.revision, {
      batch: plan.batch,
      edits: plan.edits,
      deleteEditsFor: plan.report.removed,
      by: options.actor,
      history: false,
    })
    if (outcome === 'revision_mismatch') continue
    if (outcome !== 'ok') return { ...result, applied: false, refused: outcome }
    return { ...result, draftRevision: plan.batch.revision }
  }
  return { ...report, refused: 'superseded_revision' }
}
