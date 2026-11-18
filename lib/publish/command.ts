import type { EditableFields, ReviewBatch } from '../review/types'
import type { PublishCommand, PublishRecord } from './types'

/** Identify the publish receipt shared by commands for the same batch revision. */
export const receiptId = (batchId: string, revision: number) => `${batchId}@${revision}`
/**
 * Derive the workflow start token used to make starting one publish command idempotent.
 */
export const publishStartToken = (commandId: string) => `publish-command:${commandId}`

/** Check whether a newer command on the batch has displaced the supplied claim. */
export function claimSupersedes(batch: Partial<ReviewBatch> | null | undefined, command: PublishCommand): boolean {
  return batch?.publishCommand?.revision === command.revision && batch.publishCommand.commandId !== command.commandId
}

/** Allow an owner to confirm a draft while it is open or submitted. */
export const draftCanBeConfirmed = (batch: { state: string }) => batch.state === 'open' || batch.state === 'submitted'

/** Check that field edits or state order changes would produce a different snapshot. */
export function hasDraftChanges(batch: ReviewBatch, edits: EditableFields[]): boolean {
  return edits.some(fields => Object.keys(fields).length > 0) || Object.entries(batch.stateOrders ?? {}).some(([state, order]) => {
    const baseline = batch.baselineOrders?.[state]
    return order.length > 0 && (!baseline || order.length !== baseline.length || order.some((id, index) => id !== baseline[index]))
  })
}

/** Match the approved batch revision to the command that expects to publish it. */
export function batchApprovedFor(batch: Partial<ReviewBatch> | null | undefined, command: PublishCommand): boolean {
  return batch?.state === 'approved' && batch.revision === command.revision && batch.approval?.revision === command.revision - 1
}

/** Recognize commands fenced by the receipt's current or superseded command records. */
export function isSuperseded(record: PublishRecord | null, command: PublishCommand): boolean {
  return !!record && (record.committedAt !== undefined && record.commandId !== command.commandId || !!record.supersededCommands?.some(previous => previous.commandId === command.commandId))
}
