import { activationResult, nextAuthorityEpoch, isActiveOwner, normalizeEmail, pendingMember } from './member'
import type { Member, MembersStore } from './types'

export function createMemoryMembersStore(seed: Member[] = [], now: () => string = () => new Date().toISOString()): MembersStore {
  const members = new Map(seed.map(member => [normalizeEmail(member.email), structuredClone({ ...member, email: normalizeEmail(member.email) })]))
  const epochs = new Map(seed.map(member => [normalizeEmail(member.email), member.authorityEpoch ?? 0]))
  const increment = (email: string) => { const epoch = nextAuthorityEpoch({ authorityEpoch: epochs.get(email) }); epochs.set(email, epoch); return epoch }
  return {
    async getByEmail(email) { return structuredClone(members.get(normalizeEmail(email)) ?? null) },
    async getByUid(uid) { return structuredClone([...members.values()].find(member => member.uid === uid) ?? null) },
    async getByInviteHash(tokenHash) { return structuredClone([...members.values()].find(member => member.invite?.tokenHash === tokenHash) ?? null) },
    async list() { return structuredClone([...members.values()].sort((a, b) => a.email.localeCompare(b.email))) },
    async create(input) {
      const email = normalizeEmail(input.email)
      if (members.has(email)) return 'exists'
      members.set(email, structuredClone({ ...pendingMember(input, now()), authorityEpoch: increment(email) }))
      return 'ok'
    },
    async updateRole(email, role) {
      const member = members.get(normalizeEmail(email))
      if (!member) return 'not_found'
      member.authorityEpoch = increment(normalizeEmail(email))
      member.role = role
      return 'ok'
    },
    async updateRoleGuarded(email, role) {
      const member = members.get(normalizeEmail(email))
      if (!member) return 'not_found'
      if (isActiveOwner(member) && role !== 'owner' && [...members.values()].filter(isActiveOwner).length <= 1) return 'last_owner'
      member.authorityEpoch = increment(normalizeEmail(email))
      member.role = role
      return 'ok'
    },
    async removeGuarded(email) {
      const key = normalizeEmail(email)
      const member = members.get(key)
      if (!member) return 'not_found'
      if (isActiveOwner(member) && [...members.values()].filter(isActiveOwner).length <= 1) return 'last_owner'
      increment(key)
      members.delete(key)
      return 'ok'
    },
    async reissue(email, invite) {
      const member = members.get(normalizeEmail(email))
      if (!member) return 'not_found'
      if (member.status !== 'pending') return 'invalid_state'
      member.invite = structuredClone(invite)
      return 'ok'
    },
    async activate(email, uid, tokenHash) {
      const member = members.get(normalizeEmail(email))
      if (!member) return 'not_found'
      const result = activationResult(member, now(), tokenHash)
      if (result !== 'ok') return result
      member.authorityEpoch = increment(normalizeEmail(email))
      member.uid = uid
      member.status = 'active'
      member.invite = null
      return 'ok'
    },
    async remove(email) { const key = normalizeEmail(email); if (!members.has(key)) return 'not_found'; increment(key); members.delete(key); return 'ok' },
    async upsertSeed(member) {
      const email = normalizeEmail(member.email)
      const previous = members.get(email)
      const unchanged = previous && ['uid', 'role', 'status'].every(key => previous[key as keyof Member] === member[key as keyof Member])
      const { removedAt, ...restored } = member
      void removedAt
      members.set(email, structuredClone({ ...restored, email, authorityEpoch: unchanged ? previous.authorityEpoch ?? 0 : increment(email) }))
    },
  }
}
