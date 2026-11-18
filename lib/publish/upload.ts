import { occupiesTarget, validTarget } from './allocation'
import { sameRequester } from './authority'
import { receiptId } from './command'
import { PUBLISH_ERRORS } from './stop'
import type { PublishCommand, PublishError, PublishRecord } from './types'

/**
 * Check whether the saved receipt still authorizes uploading the version reserved by
 * this command.
 */
export function uploadError(
  saved: PublishRecord | null,
  record: PublishRecord,
  command: PublishCommand,
  checksum: string,
  liveVersion: number,
  committedVersion: boolean
): PublishError | null {
  if (
    !saved ||
    saved.commandId !== command.commandId ||
    record.commandId !== command.commandId ||
    saved.generation !== command.generation ||
    record.generation !== saved.generation ||
    !sameRequester(saved.requestedBy, command.requestedBy) ||
    !sameRequester(record.requestedBy, command.requestedBy)
  )
    return PUBLISH_ERRORS.superseded
  if (
    saved.id !== receiptId(command.batchId, command.revision) ||
    record.id !== saved.id ||
    saved.batchId !== command.batchId ||
    saved.revision !== command.revision ||
    record.batchId !== saved.batchId ||
    record.revision !== saved.revision
  )
    return 'version_taken'
  if (
    saved.committedAt ||
    committedVersion ||
    !validTarget(saved.fromVersion, saved.toVersion) ||
    !occupiesTarget(saved) ||
    record.fromVersion !== saved.fromVersion ||
    record.toVersion !== saved.toVersion ||
    saved.blobSha256 !== checksum ||
    record.blobSha256 !== checksum
  )
    return 'version_taken'
  return liveVersion !== saved.fromVersion ? 'stale_baseline' : null
}
