import type { Firestore, Transaction } from '@google-cloud/firestore'
import {
  activationResult,
  nextAuthorityEpoch,
  isActiveOwner,
  isLiveMember,
  memberTombstone,
  restoredMember,
  normalizeEmail,
  pendingMember,
} from './member'
import type {
  GuardedMemberResult,
  Member,
  MemberResult,
  MembersStore,
} from './types'

/**
 * Find the live membership for a Firebase UID inside an existing transaction when
 * supplied.
 */
export async function firestoreMemberByUid(
  db: Firestore,
  uid: string,
  transaction?: Transaction
): Promise<Member | null> {
  const query = db.collection('members').where('uid', '==', uid).limit(1)
  const snapshot = transaction
    ? await transaction.get(query)
    : await query.get()
  return (
    snapshot.docs.map((doc) => doc.data() as Member).find(isLiveMember) ?? null
  )
}

/**
 * Build the membership store that manages live records, invitations and authority
 * changes transactionally.
 */
export function firestoreMembersStore(
  db: Firestore,
  now: () => string = () => new Date().toISOString()
): MembersStore {
  const members = db.collection('members')
  /** Address a membership document through the normalized and encoded email key. */
  const ref = (email: string) =>
    members.doc(encodeURIComponent(normalizeEmail(email)))
  /**
   * Apply one member mutation transactionally so it observes the latest stored record.
   */
  async function mutate(
    email: string,
    change: (member: Member) => MemberResult
  ): Promise<MemberResult> {
    return db.runTransaction(async (transaction) => {
      const document = ref(email)
      const snapshot = await transaction.get(document)
      if (!isLiveMember(snapshot.data())) return 'not_found'
      const member = snapshot.data() as Member
      const result = change(member)
      if (result === 'ok') transaction.set(document, member)
      return result
    })
  }
  /**
   * Change or remove a role under the last-owner guard and invalidate any removed
   * member's live access.
   */
  async function guarded(
    email: string,
    role?: Member['role']
  ): Promise<GuardedMemberResult> {
    return db.runTransaction(async (transaction) => {
      const document = ref(email)
      const snapshot = await transaction.get(document)
      if (!isLiveMember(snapshot.data())) return 'not_found'
      const member = snapshot.data() as Member
      if (role === member.role) return 'ok'
      if (isActiveOwner(member) && role !== 'owner') {
        const owners = await transaction.get(
          members.where('role', '==', 'owner')
        )
        if (owners.docs.filter((doc) => isActiveOwner(doc.data())).length <= 1)
          return 'last_owner'
      }
      if (role)
        transaction.update(document, {
          role,
          authorityEpoch: nextAuthorityEpoch(member),
        })
      else {
        transaction.set(document, memberTombstone(member, now()))
        if (member.uid)
          transaction.delete(db.doc(`curatorLiveAccess/${member.uid}`))
      }
      return 'ok'
    })
  }
  return {
    /** Look up a live member by normalized email and hide tombstones. */
    async getByEmail(email) {
      const member = (await ref(email).get()).data() as Member | undefined
      return isLiveMember(member) ? member : null
    },
    /** Resolve the current live member for a Firebase UID. */
    getByUid: (uid) => firestoreMemberByUid(db, uid),
    /** Find the live member linked to the presented invitation hash. */
    async getByInviteHash(tokenHash) {
      const snapshot = await members
        .where('invite.tokenHash', '==', tokenHash)
        .limit(1)
        .get()
      return (
        snapshot.docs.map((doc) => doc.data() as Member).find(isLiveMember) ??
        null
      )
    },
    /** List live memberships in email order for the owner workspace. */
    async list() {
      return (await members.get()).docs
        .map((doc) => doc.data() as Member)
        .filter(isLiveMember)
        .sort((a, b) => a.email.localeCompare(b.email))
    },
    /**
     * Create a pending member or restore its tombstone without replacing an active
     * record.
     */
    async create(input) {
      return db.runTransaction(async (transaction) => {
        const document = ref(input.email)
        const previous = await transaction.get(document)
        if (isLiveMember(previous.data())) return 'exists'
        transaction.set(
          document,
          restoredMember(
            pendingMember(input, now()),
            previous.data() as Member | undefined
          )
        )
        return 'ok'
      })
    },
    /**
     * Change a live member's role and advance their authority epoch when owner access
     * changes.
     */
    async updateRole(email, role) {
      return mutate(email, (member) => {
        if (member.role === role) return 'ok'
        member.role = role
        member.authorityEpoch = nextAuthorityEpoch(member)
        return 'ok'
      })
    },
    /** Apply a role change while protecting the last active owner. */
    updateRoleGuarded: (email, role) => guarded(email, role),
    /** Remove the member while preserving at least one active owner. */
    removeGuarded: (email) => guarded(email),
    /** Replace a pending member's invitation with a fresh token record. */
    async reissue(email, invite) {
      return mutate(email, (member) => {
        if (member.status !== 'pending') return 'invalid_state'
        member.invite = invite
        return 'ok'
      })
    },
    /** Activate a pending invitation after checking its current hash and expiry. */
    async activate(email, uid, tokenHash) {
      return mutate(email, (member) => {
        const result = activationResult(member, now(), tokenHash)
        if (result !== 'ok') return result
        member.authorityEpoch = nextAuthorityEpoch(member)
        member.uid = uid
        member.status = 'active'
        member.invite = null
        return 'ok'
      })
    },
    /** Replace a membership with a tombstone and delete the removed user's live grant. */
    async remove(email) {
      return db.runTransaction(async (transaction) => {
        const document = ref(email)
        const snapshot = await transaction.get(document)
        if (!isLiveMember(snapshot.data())) return 'not_found'
        const member = snapshot.data() as Member
        transaction.set(document, memberTombstone(member, now()))
        if (member.uid)
          transaction.delete(db.doc(`curatorLiveAccess/${member.uid}`))
        return 'ok'
      })
    },
    /**
     * Upsert a demo membership while preserving the authority epoch across restoration.
     */
    async upsertSeed(member) {
      await db.runTransaction(async (transaction) => {
        const document = ref(member.email)
        const previous = await transaction.get(document)
        transaction.set(
          document,
          restoredMember(member, previous.data() as Member | undefined)
        )
      })
    },
  }
}
