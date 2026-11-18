import type { Member, MemberResult, PendingMember } from './types'

/** Normalize email casing and whitespace for stable membership lookup. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Derive the displayed membership status from the invitation's expiry. */
export function memberStatus(member: Member, now: string): Member['status'] | 'expired' {
  return member.status === 'pending' && member.invite && Date.parse(member.invite.expiresAt) <= Date.parse(now) ? 'expired' : member.status
}

/** Construct the pending record before an invited account is linked to a UID. */
export function pendingMember(input: PendingMember, now: string): Member {
  return { ...input, email: normalizeEmail(input.email), status: 'pending', uid: null, createdAt: now }
}

/**
 * Explain whether the current pending invitation can activate with the supplied token
 * hash.
 */
export function activationResult(member: Member, now: string, tokenHash?: string): MemberResult {
  if (member.status !== 'pending') return 'invalid_state'
  if (memberStatus(member, now) === 'expired') return 'expired'
  if (tokenHash !== undefined && member.invite?.tokenHash !== tokenHash) return 'hash_mismatch'
  return 'ok'
}

/** Check that a stored membership is pending or active and can be used by the app. */
export function isLiveMember(member: unknown): member is { status: 'pending' | 'active' } {
  return typeof member === 'object' && member !== null &&
    (!('removedAt' in member) || !member.removedAt) &&
    'status' in member && (member.status === 'pending' || member.status === 'active')
}

/** Require an active owner record bound to a UID before authorizing owner operations. */
export function isActiveOwner(member: unknown): member is { role: 'owner'; status: 'active'; uid: string } {
  return isLiveMember(member) && member.status === 'active' &&
    'role' in member && member.role === 'owner' &&
    'uid' in member && typeof member.uid === 'string' && member.uid.length > 0
}

/**
 * Check that a requester still matches the current owner identity and authority epoch.
 */
export function hasOwnerAuthority(member: unknown, authority: { uid: string; authorityEpoch: number }): boolean {
  if (!isActiveOwner(member) || member.uid !== authority.uid) return false
  const epoch = 'authorityEpoch' in member ? member.authorityEpoch : 0
  return Number.isSafeInteger(epoch) && epoch === authority.authorityEpoch
}

/** Retain a removed membership's identity history and advance its authority epoch. */
export function memberTombstone(member: Member, now: string): Member {
  return { ...member, status: 'removed', uid: null, invite: null, removedAt: now, authorityEpoch: nextAuthorityEpoch(member) }
}

/**
 * Restore a membership using the prior authority epoch so stale permissions do not
 * return.
 */
export function restoredMember(member: Member, previous?: Member): Member {
  const { removedAt, ...restored } = member
  void removedAt
  const unchanged = isLiveMember(previous) && (['uid', 'role', 'status'] as const).every(key => previous[key] === member[key])
  return { ...restored, email: normalizeEmail(member.email), authorityEpoch: unchanged ? previous.authorityEpoch ?? 0 : nextAuthorityEpoch(previous) }
}

/** Advance a member's authority epoch while enforcing a safe integer range. */
export function nextAuthorityEpoch(member: { authorityEpoch?: number } | null | undefined): number {
  const epoch = (member?.authorityEpoch ?? 0) + 1
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Member authority exhausted')
  return epoch
}
