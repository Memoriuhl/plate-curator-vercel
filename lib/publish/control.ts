import { hasRequesterAuthority } from './authority'
import { receiptId } from './command'
import { PUBLISH_STOPS } from './stop'
import type { PublishCommand, PublishControlState, PublishStop } from './types'

/** Validate stored publish control data before using it to authorize an operation. */
export function parsePublishControl(data: unknown): PublishControlState | null {
  if (!data || typeof data !== 'object') return null
  const value = data as Partial<PublishControlState>
  return typeof value.paused === 'boolean' && typeof value.generation === 'number' && Number.isSafeInteger(value.generation) && value.generation > 0 &&
    typeof value.changedBy?.uid === 'string' && value.changedBy.uid.length > 0 &&
    typeof value.changedBy?.email === 'string' && value.changedBy.email.length > 0 &&
    typeof value.changedAt === 'string' && Number.isFinite(Date.parse(value.changedAt))
    ? value as PublishControlState : null
}

/** Check the control state and generation to decide whether the command must stop. */
export function publishControlStop(control: PublishControlState | null, command?: PublishCommand): PublishStop | null {
  if (!control) return PUBLISH_STOPS.notEnabled
  if (command && (!Number.isSafeInteger(command.generation) || !hasRequesterAuthority(command.requestedBy))) return PUBLISH_STOPS.superseded
  if (control.paused) return PUBLISH_STOPS.paused
  if (command && command.generation !== control.generation) return PUBLISH_STOPS.superseded
  return null
}

/**
 * Resolve the command's durable key, including the legacy key used before explicit IDs.
 */
export function publishCommandKey(command: PublishCommand): string {
  return command.commandId ?? `${receiptId(command.batchId, command.revision)}:legacy`
}
