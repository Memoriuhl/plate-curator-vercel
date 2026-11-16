import type { Member, MemberResult, PendingMember } from './types'

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function memberStatus(member: Member, now: string): Member['status'] | 'expired' {
  return member.status === 'pending' && member.invite && Date.parse(member.invite.expiresAt) <= Date.parse(now) ? 'expired' : member.status
}

export function pendingMember(input: PendingMember, now: string): Member {
  return { ...input, email: normalizeEmail(input.email), status: 'pending', uid: null, createdAt: now }
}

export function activationResult(member: Member, now: string, tokenHash?: string): MemberResult {
  if (member.status !== 'pending') return 'invalid_state'
  if (memberStatus(member, now) === 'expired') return 'expired'
  if (tokenHash !== undefined && member.invite?.tokenHash !== tokenHash) return 'hash_mismatch'
  return 'ok'
}
