import type { Firestore } from '@google-cloud/firestore'
import { activationResult, nextAuthorityEpoch, isActiveOwner, normalizeEmail, pendingMember } from './member'
import type { GuardedMemberResult, Member, MemberResult, MembersStore } from './types'

export function firestoreMembersStore(db: Firestore, now: () => string = () => new Date().toISOString()): MembersStore {
  const members = db.collection('members')
  const ref = (email: string) => members.doc(encodeURIComponent(normalizeEmail(email)))
  async function mutate(email: string, change: (member: Member) => MemberResult): Promise<MemberResult> {
    return db.runTransaction(async transaction => {
      const document = ref(email)
      const snapshot = await transaction.get(document)
      if (!snapshot.exists || snapshot.get('removedAt')) return 'not_found'
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
      if (!snapshot.exists || snapshot.get('removedAt')) return 'not_found'
      const member = snapshot.data() as Member
      if (isActiveOwner(member) && role !== 'owner') {
        const owners = await transaction.get(members.where('role', '==', 'owner'))
        if (owners.docs.filter(doc => isActiveOwner(doc.data() as Member)).length <= 1) return 'last_owner'
      }
      if (role) transaction.update(document, { role, authorityEpoch: nextAuthorityEpoch(member) })
      else {
        transaction.set(document, { ...member, uid: null, invite: null, removedAt: now(), authorityEpoch: nextAuthorityEpoch(member) })
        if (member.uid) transaction.delete(db.doc(`curatorLiveAccess/${member.uid}`))
      }
      return 'ok'
    })
  }
  return {
    async getByEmail(email) { const member = (await ref(email).get()).data() as Member | undefined; return member && !member.removedAt ? member : null },
    async getByUid(uid) {
      const snapshot = await members.where('uid', '==', uid).limit(1).get()
      return snapshot.docs.map(doc => doc.data() as Member).find(member => !member.removedAt) ?? null
    },
    async getByInviteHash(tokenHash) {
      const snapshot = await members.where('invite.tokenHash', '==', tokenHash).limit(1).get()
      return snapshot.docs[0]?.data() as Member | undefined ?? null
    },
    async list() { return (await members.get()).docs.map(doc => doc.data() as Member).filter(member => !member.removedAt).sort((a, b) => a.email.localeCompare(b.email)) },
    async create(input) {
      return db.runTransaction(async transaction => {
        const document = ref(input.email)
        const previous = await transaction.get(document)
        if (previous.exists && !previous.get('removedAt')) return 'exists'
        transaction.set(document, { ...pendingMember(input, now()), authorityEpoch: nextAuthorityEpoch(previous.data()) })
        return 'ok'
      })
    },
    async updateRole(email, role) { return mutate(email, member => { member.role = role; member.authorityEpoch = nextAuthorityEpoch(member); return 'ok' }) },
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
        if (!snapshot.exists || snapshot.get('removedAt')) return 'not_found'
        const member = snapshot.data() as Member
        transaction.set(document, { ...member, uid: null, invite: null, removedAt: now(), authorityEpoch: nextAuthorityEpoch(member) })
        if (member.uid) transaction.delete(db.doc(`curatorLiveAccess/${member.uid}`))
        return 'ok'
      })
    },
    async upsertSeed(member) {
      await db.runTransaction(async transaction => {
        const document = ref(member.email)
        const previous = await transaction.get(document)
        const { removedAt, ...restored } = member
        void removedAt
        const unchanged = previous.exists && !previous.get('removedAt') && (['uid', 'role', 'status'] as const).every(key => previous.get(key) === restored[key])
        transaction.set(document, { ...restored, email: normalizeEmail(member.email), authorityEpoch: unchanged ? previous.get('authorityEpoch') ?? 0 : nextAuthorityEpoch(previous.data()) })
      })
    },
  }
}
