import type { ReviewBatch } from '../review/types'
import type { PublishCommand, PublishRecord } from './types'

export const receiptId = (batchId: string, revision: number) => `${batchId}@${revision}`
export const publishStartToken = (commandId: string) => `publish-command:${commandId}`

export function claimSupersedes(batch: Partial<ReviewBatch> | null | undefined, command: PublishCommand): boolean {
  return batch?.publishCommand?.revision === command.revision && batch.publishCommand.commandId !== command.commandId
}

export const draftCanBeConfirmed = (batch: { state: string }) => batch.state === 'open' || batch.state === 'submitted'

export function batchApprovedFor(batch: Partial<ReviewBatch> | null | undefined, command: PublishCommand): boolean {
  return batch?.state === 'approved' && batch.revision === command.revision && batch.approval?.revision === command.revision - 1
}

export function isSuperseded(record: PublishRecord | null, command: PublishCommand): boolean {
  return !!record && (record.committedAt !== undefined && record.commandId !== command.commandId || !!record.supersededCommands?.some(previous => previous.commandId === command.commandId))
}
