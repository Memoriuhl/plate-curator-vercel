import type { Actor, Role } from '../review/types'

export function roleFor(uid: string, ownerUids: string[]): Role {
  return ownerUids.includes(uid) ? 'owner' : 'editor'
}

export function parseOwnerUids(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((uid) => uid.trim()).filter(Boolean)
}

export async function authenticate(request: Request, deps: { verify: (token: string) => Promise<{ uid: string; name?: string; email?: string } | null>; ownerUids: string[] }): Promise<{ ok: true; actor: Actor } | { ok: false; response: Response }> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') ?? '')
  if (match) {
    const user = await deps.verify(match[1])
    if (user) {
      const name = (user.name?.trim() || user.email?.split('@')[0].trim() || '').slice(0, 60) || null
      return { ok: true, actor: { uid: user.uid, name, role: roleFor(user.uid, deps.ownerUids) } }
    }
  }
  return {
    ok: false,
    response: Response.json({ error: 'unauthenticated' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } }),
  }
}
