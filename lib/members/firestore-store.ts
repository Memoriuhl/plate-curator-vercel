import type { Firestore, Transaction } from '@google-cloud/firestore'
import { activationResult, nextAuthorityEpoch, isActiveOwner, isLiveMember, memberTombstone, restoredMember, normalizeEmail, pendingMember } from './member'
import type { GuardedMemberResult, Member, MemberResult, MembersStore } from './types'

export async function firestoreMemberByUid(db: Firestore, uid: string, transaction?: Transaction): Promise<Member | null> {
  const query = db.collection('members').where('uid', '==', uid).limit(1)
  const snapshot = transaction ? await transaction.get(query) : await query.get()
  return snapshot.docs.map(doc => doc.data() as Member).find(isLiveMember) ?? null
}

export function firestoreMembersStore(db: Firestore, now: () => string = () => new Date().toISOString()): MembersStore {
  const members = db.collection('members')
  const ref = (email: string) => members.doc(encodeURIComponent(normalizeEmail(email)))
  async function mutate(email: string, change: (member: Member) => MemberResult): Promise<MemberResult> {
    return db.runTransaction(async transaction => {
      const document = ref(email)
      const snapshot = await transaction.get(document)
      if (!isLiveMember(snapshot.data())) return 'not_found'
      const member = snapshot.data() as Member
      const result = change(member)
      if (result === 'ok') transaction.set(document, member)
      return result
    })
  }
  async function guarded(email: string, role?: Member['role']): Promise<GuardedMemberResult> {
    return db.runTransaction(async transaction => {
      const document = ref(email)
      const snapshot = await transaction.get(document)
      if (!isLiveMember(snapshot.data())) return 'not_found'
      const member = snapshot.data() as Member
      if (role === member.role) return 'ok'
      if (isActiveOwner(member) && role !== 'owner') {
        const owners = await transaction.get(members.where('role', '==', 'owner'))
        if (owners.docs.filter(doc => isActiveOwner(doc.data())).length <= 1) return 'last_owner'
      }
      if (role) transaction.update(document, { role, authorityEpoch: nextAuthorityEpoch(member) })
      else {
        transaction.set(document, memberTombstone(member, now()))
        if (member.uid) transaction.delete(db.doc(`curatorLiveAccess/${member.uid}`))
      }
      return 'ok'
    })
  }
  return {
    async getByEmail(email) { const member = (await ref(email).get()).data() as Member | undefined; return isLiveMember(member) ? member : null },
    getByUid: uid => firestoreMemberByUid(db, uid),
    async getByInviteHash(tokenHash) {
      const snapshot = await members.where('invite.tokenHash', '==', tokenHash).limit(1).get()
      return snapshot.docs.map(doc => doc.data() as Member).find(isLiveMember) ?? null
    },
    async list() { return (await members.get()).docs.map(doc => doc.data() as Member).filter(isLiveMember).sort((a, b) => a.email.localeCompare(b.email)) },
    async create(input) {
      return db.runTransaction(async transaction => {
        const document = ref(input.email)
        const previous = await transaction.get(document)
        if (isLiveMember(previous.data())) return 'exists'
        transaction.set(document, restoredMember(pendingMember(input, now()), previous.data() as Member | undefined))
        return 'ok'
      })
    },
    async updateRole(email, role) { return mutate(email, member => { if (member.role === role) return 'ok'; member.role = role; member.authorityEpoch = nextAuthorityEpoch(member); return 'ok' }) },
    updateRoleGuarded: (email, role) => guarded(email, role),
    removeGuarded: email => guarded(email),
    async reissue(email, invite) {
      return mutate(email, member => {
        if (member.status !== 'pending') return 'invalid_state'
        member.invite = invite
        return 'ok'
      })
    },
    async activate(email, uid, tokenHash) {
      return mutate(email, member => {
        const result = activationResult(member, now(), tokenHash)
        if (result !== 'ok') return result
        member.authorityEpoch = nextAuthorityEpoch(member)
        member.uid = uid
        member.status = 'active'
        member.invite = null
        return 'ok'
      })
    },
    async remove(email) {
      return db.runTransaction(async transaction => {
        const document = ref(email)
        const snapshot = await transaction.get(document)
        if (!isLiveMember(snapshot.data())) return 'not_found'
        const member = snapshot.data() as Member
        transaction.set(document, memberTombstone(member, now()))
        if (member.uid) transaction.delete(db.doc(`curatorLiveAccess/${member.uid}`))
        return 'ok'
      })
    },
    async upsertSeed(member) {
      await db.runTransaction(async transaction => {
        const document = ref(member.email)
        const previous = await transaction.get(document)
        transaction.set(document, restoredMember(member, previous.data() as Member | undefined))
      })
    },
  }
}
