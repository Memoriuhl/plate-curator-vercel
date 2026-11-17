export const PUBLISH_STOPS = {
  paused: 'paused',
  revoked: 'revoked',
  superseded: 'superseded',
  notEnabled: 'publish_not_enabled',
} as const

export type PublishStop = typeof PUBLISH_STOPS[keyof typeof PUBLISH_STOPS]

export function isPublishStop(error: unknown): error is PublishStop {
  return Object.values(PUBLISH_STOPS).some(stop => stop === error)
}

export const PUBLISH_STOP_MESSAGES: Record<PublishStop, string> = {
  [PUBLISH_STOPS.paused]: 'Catalog publishing is paused.',
  [PUBLISH_STOPS.revoked]: 'The Publish requester lost Owner access (revoked).',
  [PUBLISH_STOPS.superseded]: 'This Publish command was superseded.',
  [PUBLISH_STOPS.notEnabled]: 'Catalog publishing is not enabled yet.',
}
