import { normalizeEmail } from '@/lib/members/member'
import type { GuardedMemberResult } from '@/lib/members/types'
import { currentActor } from '@/lib/server/context'
import { membersStore } from '@/lib/server/members'
import { badRequest, json, readJson } from '@/lib/server/respond'

type Context = { params: Promise<{ email: string }> }
/**
 * Translate guarded membership writes into success, missing-member or last-owner
 * responses.
 */
function resultResponse(result: GuardedMemberResult) {
  return result === 'ok'
    ? json({ ok: true })
    : json({ error: result }, result === 'last_owner' ? 409 : 404)
}
/** Require an authenticated owner for a membership mutation. */
async function owner(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  if (auth.actor.role !== 'owner') return json({ error: 'forbidden' }, 403)
  return null
}
/** Decode and validate the email path parameter before looking up the membership. */
async function memberEmail(context: Context) {
  const email = normalizeEmail((await context.params).email)
  return email.length <= 254 && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)
    ? email
    : null
}
/** Change a member's role while protecting the last active owner. */
export async function PATCH(request: Request, context: Context) {
  const refused = await owner(request)
  if (refused) return refused
  const email = await memberEmail(context)
  const body = await readJson(request)
  if (
    !email ||
    !body ||
    Object.keys(body).some((key) => key !== 'role') ||
    (body.role !== 'editor' && body.role !== 'owner')
  )
    return badRequest()
  return resultResponse(
    await membersStore().updateRoleGuarded(email, body.role)
  )
}
/** Remove a member while protecting the last active owner. */
export async function DELETE(request: Request, context: Context) {
  const refused = await owner(request)
  if (refused) return refused
  const email = await memberEmail(context)
  if (!email) return badRequest()
  return resultResponse(await membersStore().removeGuarded(email))
}
