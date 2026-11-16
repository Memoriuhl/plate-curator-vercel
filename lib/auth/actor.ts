import type { Actor, Role } from '../review/types'
import { memberStatus, normalizeEmail } from '../members/member'
import type { MembersStore } from '../members/types'
import type { VerifiedIdentity } from './verify-id-token'

export function parseOwnerUids(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((uid) => uid.trim()).filter(Boolean)
}

export async function authenticate(request: Request, deps: { verify: (token: string) => Promise<VerifiedIdentity | null>; ownerUids: string[]; members: Pick<MembersStore, 'getByEmail' | 'getByUid' | 'activate'>; now?: () => string }): Promise<{ ok: true; actor: Actor } | { ok: false; response: Response }> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') ?? '')
  if (match) {
    const user = await deps.verify(match[1])
    if (user) {
      const name = (user.name?.trim() || user.email?.split('@')[0].trim() || '').slice(0, 60) || null
      const accepted = (role: Role) => ({ ok: true as const, actor: { uid: user.uid, name, role } })
      if (deps.ownerUids.includes(user.uid)) return accepted('owner')
      const bound = await deps.members.getByUid(user.uid)
      if (bound?.uid === user.uid && bound.signIn === 'password' && bound.status === 'active') return accepted(bound.role)
      if (user.signInProvider === 'google.com' && user.emailVerified && user.email?.trim()) {
        const email = normalizeEmail(user.email)
        let member = await deps.members.getByEmail(email)
        if (member?.signIn === 'google') {
          if (member.status === 'pending' && memberStatus(member, (deps.now ?? (() => new Date().toISOString()))()) !== 'expired') {
            const result = await deps.members.activate(email, user.uid)
            member = result === 'ok' || result === 'invalid_state' ? await deps.members.getByEmail(email) : null
          }
          if (member?.signIn === 'google' && member.status === 'active' && member.uid === user.uid) return accepted(member.role)
        }
      }
      return {
        ok: false,
        response: Response.json({ error: 'not_member' }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } }),
      }
    }
  }
  return {
    ok: false,
    response: Response.json({ error: 'unauthenticated' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } }),
  }
}
