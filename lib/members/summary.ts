import { isLiveMember, memberStatus } from './member'
import type { Member } from './types'

export type MemberSummary = Pick<
  Member,
  'email' | 'role' | 'signIn' | 'invitedBy' | 'createdAt'
> & { status: 'pending' | 'active' | 'expired' }
export type MemberInvite = { member: MemberSummary; inviteUrl: string }

/**
 * Build the owner-facing membership summary with effective invitation status and safe
 * display fields.
 */
export function memberSummary(member: Member, now: string): MemberSummary {
  if (!isLiveMember(member)) throw new Error('Removed member has no summary')
  return {
    email: member.email,
    role: member.role,
    signIn: member.signIn,
    status: memberStatus(member, now) === 'expired' ? 'expired' : member.status,
    invitedBy: member.invitedBy,
    createdAt: member.createdAt,
  }
}
