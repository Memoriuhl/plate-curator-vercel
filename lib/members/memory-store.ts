import { activationResult, normalizeEmail, pendingMember } from './member'
import type { Member, MembersStore } from './types'

export function createMemoryMembersStore(seed: Member[] = [], now: () => string = () => new Date().toISOString()): MembersStore {
  const members = new Map(seed.map(member => [normalizeEmail(member.email), structuredClone({ ...member, email: normalizeEmail(member.email) })]))
  return {
    async getByEmail(email) { return structuredClone(members.get(normalizeEmail(email)) ?? null) },
    async getByUid(uid) { return structuredClone([...members.values()].find(member => member.uid === uid) ?? null) },
    async list() { return structuredClone([...members.values()].sort((a, b) => a.email.localeCompare(b.email))) },
    async create(input) {
      const email = normalizeEmail(input.email)
      if (members.has(email)) return 'exists'
      members.set(email, structuredClone(pendingMember(input, now())))
      return 'ok'
    },
    async updateRole(email, role) {
      const member = members.get(normalizeEmail(email))
      if (!member) return 'not_found'
      member.role = role
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
      member.uid = uid
      member.status = 'active'
      member.invite = null
      return 'ok'
    },
    async remove(email) { return members.delete(normalizeEmail(email)) ? 'ok' : 'not_found' },
    async upsertSeed(member) { members.set(normalizeEmail(member.email), structuredClone({ ...member, email: normalizeEmail(member.email) })) },
  }
}
