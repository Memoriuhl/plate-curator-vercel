import { activationResult, nextAuthorityEpoch, isActiveOwner, isLiveMember, memberTombstone, restoredMember, normalizeEmail, pendingMember } from './member'
import type { Member, MembersStore } from './types'

/** Provide the membership contract in memory for fixtures and deterministic tests. */
export function createMemoryMembersStore(seed: Member[] = [], now: () => string = () => new Date().toISOString()): MembersStore {
  const members = new Map(seed.map(member => [normalizeEmail(member.email), structuredClone({ ...member, email: normalizeEmail(member.email) })]))
  /** Resolve an active or pending record by normalized email while hiding tombstones. */
  const live = (email: string) => {
    const member = members.get(normalizeEmail(email))
    return isLiveMember(member) ? member : null
  }
  return {
    /** Return a copy of the live member associated with an email address. */
    async getByEmail(email) { return structuredClone(live(email)) },
    /** Find a live member by Firebase UID and return a detached copy. */
    async getByUid(uid) { return structuredClone([...members.values()].find(member => isLiveMember(member) && member.uid === uid) ?? null) },
    /** Resolve a live invitation by token hash and return a detached record. */
    async getByInviteHash(tokenHash) { return structuredClone([...members.values()].find(member => isLiveMember(member) && member.invite?.tokenHash === tokenHash) ?? null) },
    /** Return live membership snapshots in stable email order. */
    async list() { return structuredClone([...members.values()].filter(isLiveMember).sort((a, b) => a.email.localeCompare(b.email))) },
    /** Create a pending membership unless the email already has a live record. */
    async create(input) {
      const email = normalizeEmail(input.email)
      if (live(email)) return 'exists'
      members.set(email, structuredClone(restoredMember(pendingMember(input, now()), members.get(email))))
      return 'ok'
    },
    /** Change the stored role and update the authority epoch when necessary. */
    async updateRole(email, role) {
      const member = live(email)
      if (!member) return 'not_found'
      if (member.role === role) return 'ok'
      member.authorityEpoch = nextAuthorityEpoch(member)
      member.role = role
      return 'ok'
    },
    /** Apply a role change only when it leaves an active owner in the store. */
    async updateRoleGuarded(email, role) {
      const member = live(email)
      if (!member) return 'not_found'
      if (member.role === role) return 'ok'
      if (isActiveOwner(member) && role !== 'owner' && [...members.values()].filter(isActiveOwner).length <= 1) return 'last_owner'
      member.authorityEpoch = nextAuthorityEpoch(member)
      member.role = role
      return 'ok'
    },
    /** Tombstone a live member while protecting the last active owner. */
    async removeGuarded(email) {
      const member = live(email)
      if (!member) return 'not_found'
      if (isActiveOwner(member) && [...members.values()].filter(isActiveOwner).length <= 1) return 'last_owner'
      members.set(normalizeEmail(email), memberTombstone(member, now()))
      return 'ok'
    },
    /** Replace the saved invite only when the member can still be invited. */
    async reissue(email, invite) {
      const member = live(email)
      if (!member) return 'not_found'
      if (member.status !== 'pending') return 'invalid_state'
      member.invite = structuredClone(invite)
      return 'ok'
    },
    /**
     * Activate a valid invitation and bind the resulting member to the signing-in UID.
     */
    async activate(email, uid, tokenHash) {
      const member = live(email)
      if (!member) return 'not_found'
      const result = activationResult(member, now(), tokenHash)
      if (result !== 'ok') return result
      member.authorityEpoch = nextAuthorityEpoch(member)
      member.uid = uid
      member.status = 'active'
      member.invite = null
      return 'ok'
    },
    /** Remove a live member while keeping the authority history in a tombstone. */
    async remove(email) {
      const member = live(email)
      if (!member) return 'not_found'
      members.set(normalizeEmail(email), memberTombstone(member, now()))
      return 'ok'
    },
    /**
     * Insert or restore a fixture user while preserving the previous authority history.
     */
    async upsertSeed(member) {
      const email = normalizeEmail(member.email)
      members.set(email, structuredClone(restoredMember(member, members.get(email))))
    },
  }
}
