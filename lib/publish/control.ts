import type { PublishCommand, PublishControlState, PublishStop } from './types'

export function parsePublishControl(data: unknown): PublishControlState | null {
  if (!data || typeof data !== 'object') return null
  const value = data as Partial<PublishControlState>
  return typeof value.paused === 'boolean' && Number.isSafeInteger(value.generation) && value.generation! > 0 &&
    typeof value.changedBy?.uid === 'string' && value.changedBy.uid.length > 0 &&
    typeof value.changedBy?.email === 'string' && value.changedBy.email.length > 0 &&
    typeof value.changedAt === 'string' && Number.isFinite(Date.parse(value.changedAt))
    ? value as PublishControlState : null
}

export function publishControlStop(control: PublishControlState | null, command?: PublishCommand): PublishStop | null {
  if (!control) return 'publish_not_enabled'
  if (command && !Number.isSafeInteger(command.generation)) return 'superseded'
  if (control.paused) return 'paused'
  if (command && command.generation !== control.generation) return 'superseded'
  return null
}

export function publishCommandKey(command: PublishCommand): string {
  return command.commandId ?? `${command.batchId}@${command.revision}:legacy`
}
