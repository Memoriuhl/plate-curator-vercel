import type { Firestore } from '@google-cloud/firestore'
import { activationResult, normalizeEmail, pendingMember } from './member'
import type { Member, MemberResult, MembersStore } from './types'

export function firestoreMembersStore(db: Firestore, now: () => string = () => new Date().toISOString()): MembersStore {
  const members = db.collection('members')
  const ref = (email: string) => members.doc(encodeURIComponent(normalizeEmail(email)))
  async function mutate(email: string, change: (member: Member) => MemberResult): Promise<MemberResult> {
    return db.runTransaction(async transaction => {
      const document = ref(email)
      const snapshot = await transaction.get(document)
      if (!snapshot.exists) return 'not_found'
      const member = snapshot.data() as Member
      const result = change(member)
      if (result === 'ok') transaction.set(document, member)
      return result
    })
  }
  return {
    async getByEmail(email) { return (await ref(email).get()).data() as Member | undefined ?? null },
    async getByUid(uid) {
      const snapshot = await members.where('uid', '==', uid).limit(1).get()
      return snapshot.docs[0]?.data() as Member | undefined ?? null
    },
    async list() { return (await members.get()).docs.map(doc => doc.data() as Member).sort((a, b) => a.email.localeCompare(b.email)) },
    async create(input) {
      return db.runTransaction(async transaction => {
        const document = ref(input.email)
        if ((await transaction.get(document)).exists) return 'exists'
        transaction.create(document, pendingMember(input, now()))
        return 'ok'
      })
    },
    async updateRole(email, role) { return mutate(email, member => { member.role = role; return 'ok' }) },
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
        member.uid = uid
        member.status = 'active'
        member.invite = null
        return 'ok'
      })
    },
    async remove(email) {
      return db.runTransaction(async transaction => {
        const document = ref(email)
        if (!(await transaction.get(document)).exists) return 'not_found'
        transaction.delete(document)
        return 'ok'
      })
    },
    async upsertSeed(member) { await ref(member.email).set({ ...member, email: normalizeEmail(member.email) }) },
  }
}
