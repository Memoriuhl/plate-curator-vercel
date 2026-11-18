import { hasOwnerAuthority } from '../members/member'
import { PUBLISH_STOPS, type PublishStop } from './stop'
import type { RequesterAuthority } from './types'

/**
 * Check that the requester carries the identity and authority epoch needed for a publish
 * command.
 */
export function hasRequesterAuthority(requester: Partial<RequesterAuthority> | undefined): requester is RequesterAuthority {
  return Boolean(requester && Number.isSafeInteger(requester.authorityEpoch) && typeof requester.authorityEpoch === 'number' && requester.authorityEpoch >= 0 && requester.uid && requester.email)
}

/** Stop publishing when the saved requester no longer has owner authority. */
export function publishRequesterStop(requester: Partial<RequesterAuthority> | undefined, member: unknown): PublishStop | null {
  if (!hasRequesterAuthority(requester)) return PUBLISH_STOPS.superseded
  return hasOwnerAuthority(member, requester) ? null : PUBLISH_STOPS.revoked
}

/**
 * Compare requester identity and authority epoch across retries and persisted receipts.
 */
export function sameRequester(a: RequesterAuthority | undefined, b: RequesterAuthority | undefined): boolean {
  return a?.uid === b?.uid && a?.email === b?.email && a?.authorityEpoch === b?.authorityEpoch
}

/** Include a requester in persisted data only when one is available. */
export function requesterFields(requestedBy: RequesterAuthority | null | undefined): { requestedBy?: RequesterAuthority } {
  return requestedBy ? { requestedBy } : {}
}
