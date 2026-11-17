import type { ReviewBatch } from '../review/types'
import type { PublishCommand, PublishRecord } from './types'

export const receiptId = (batchId: string, revision: number) => `${batchId}@${revision}`

export function batchApprovedFor(batch: Partial<ReviewBatch> | null | undefined, command: PublishCommand): boolean {
  return batch?.state === 'approved' && batch.revision === command.revision && batch.approval?.revision === command.revision - 1
}

export function isSuperseded(record: PublishRecord | null, command: PublishCommand): boolean {
  return !!record && (record.committedAt !== undefined && record.commandId !== command.commandId || !!record.supersededCommands?.some(previous => previous.commandId === command.commandId))
}
