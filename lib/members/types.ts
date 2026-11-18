export type Member = {
  authorityEpoch?: number
  removedAt?: string
  email: string
  role: 'editor' | 'owner'
  signIn: 'google' | 'password'
  status: 'pending' | 'active' | 'removed'
  invite: { tokenHash: string; issuedAt: string; expiresAt: string } | null
  uid: string | null
  invitedBy: string | null
  createdAt: string
}

export type PendingMember = Pick<
  Member,
  'email' | 'role' | 'signIn' | 'invitedBy'
> & { invite: NonNullable<Member['invite']> }
export type MemberResult =
  'ok' | 'not_found' | 'invalid_state' | 'expired' | 'hash_mismatch'
export type GuardedMemberResult = 'ok' | 'not_found' | 'last_owner'
export interface MembersStore {
  getByEmail(email: string): Promise<Member | null>
  getByUid(uid: string): Promise<Member | null>
  getByInviteHash(tokenHash: string): Promise<Member | null>
  list(): Promise<Member[]>
  create(input: PendingMember): Promise<'ok' | 'exists'>
  updateRole(email: string, role: Member['role']): Promise<MemberResult>
  updateRoleGuarded(
    email: string,
    role: Member['role']
  ): Promise<GuardedMemberResult>
  removeGuarded(email: string): Promise<GuardedMemberResult>
  reissue(
    email: string,
    invite: NonNullable<Member['invite']>
  ): Promise<MemberResult>
  activate(
    email: string,
    uid: string,
    tokenHash?: string
  ): Promise<MemberResult>
  remove(email: string): Promise<'ok' | 'not_found'>
  upsertSeed(member: Member): Promise<void>
}
