import { currentActor } from '@/lib/server/context'
import { membersStore } from '@/lib/server/members'
import { badRequest, json } from '@/lib/server/respond'
import { normalizeEmail } from '@/lib/members/member'
import { createInvite, generateInviteToken } from '@/lib/members/invite'

/**
 * Issue a fresh token for an existing pending invitation and return its owner-visible
 * link.
 */
export async function POST(request: Request, context: { params: Promise<{ email: string }> }) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  if (auth.actor.role !== 'owner') return json({ error: 'forbidden' }, 403)
  const email = normalizeEmail((await context.params).email)
  if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) return badRequest()
  const token = generateInviteToken()
  const result = await membersStore().reissue(email, createInvite(token))
  if (result !== 'ok') return json({ error: result }, result === 'not_found' ? 404 : 409)
  return json({ inviteUrl: `${new URL(request.url).origin}/invite/${token}` })
}
