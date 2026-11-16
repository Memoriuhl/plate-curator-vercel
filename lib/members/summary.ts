import { memberStatus } from './member'
import type { Member } from './types'

export type MemberSummary = Pick<Member, 'email' | 'role' | 'signIn' | 'invitedBy' | 'createdAt'> & { status: 'pending' | 'active' | 'expired' }
export type MemberInvite = { member: MemberSummary; inviteUrl: string }

export function memberSummary(member: Member, now: string): MemberSummary {
  return { email: member.email, role: member.role, signIn: member.signIn, status: memberStatus(member, now), invitedBy: member.invitedBy, createdAt: member.createdAt }
}
