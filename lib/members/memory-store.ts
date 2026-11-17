import { activationResult, nextAuthorityEpoch, isActiveOwner, isLiveMember, memberTombstone, restoredMember, normalizeEmail, pendingMember } from './member'
import type { Member, MembersStore } from './types'

export function createMemoryMembersStore(seed: Member[] = [], now: () => string = () => new Date().toISOString()): MembersStore {
  const members = new Map(seed.map(member => [normalizeEmail(member.email), structuredClone({ ...member, email: normalizeEmail(member.email) })]))
  const live = (email: string) => {
    const member = members.get(normalizeEmail(email))
    return isLiveMember(member) ? member : null
  }
  return {
    async getByEmail(email) { return structuredClone(live(email)) },
    async getByUid(uid) { return structuredClone([...members.values()].find(member => isLiveMember(member) && member.uid === uid) ?? null) },
    async getByInviteHash(tokenHash) { return structuredClone([...members.values()].find(member => isLiveMember(member) && member.invite?.tokenHash === tokenHash) ?? null) },
    async list() { return structuredClone([...members.values()].filter(isLiveMember).sort((a, b) => a.email.localeCompare(b.email))) },
    async create(input) {
      const email = normalizeEmail(input.email)
      if (live(email)) return 'exists'
      members.set(email, structuredClone(restoredMember(pendingMember(input, now()), members.get(email))))
      return 'ok'
    },
    async updateRole(email, role) {
      const member = live(email)
      if (!member) return 'not_found'
      if (member.role === role) return 'ok'
      member.authorityEpoch = nextAuthorityEpoch(member)
      member.role = role
      return 'ok'
    },
    async updateRoleGuarded(email, role) {
      const member = live(email)
      if (!member) return 'not_found'
      if (member.role === role) return 'ok'
      if (isActiveOwner(member) && role !== 'owner' && [...members.values()].filter(isActiveOwner).length <= 1) return 'last_owner'
      member.authorityEpoch = nextAuthorityEpoch(member)
      member.role = role
      return 'ok'
    },
    async removeGuarded(email) {
      const member = live(email)
      if (!member) return 'not_found'
      if (isActiveOwner(member) && [...members.values()].filter(isActiveOwner).length <= 1) return 'last_owner'
      members.set(normalizeEmail(email), memberTombstone(member, now()))
      return 'ok'
    },
    async reissue(email, invite) {
      const member = live(email)
      if (!member) return 'not_found'
      if (member.status !== 'pending') return 'invalid_state'
      member.invite = structuredClone(invite)
      return 'ok'
    },
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
    async remove(email) {
      const member = live(email)
      if (!member) return 'not_found'
      members.set(normalizeEmail(email), memberTombstone(member, now()))
      return 'ok'
    },
    async upsertSeed(member) {
      const email = normalizeEmail(member.email)
      members.set(email, structuredClone(restoredMember(member, members.get(email))))
    },
  }
}
