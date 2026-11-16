import { connection } from 'next/server'
import { currentActor } from '@/lib/server/context'
import { membersStore } from '@/lib/server/members'
import { badRequest, json, readJson } from '@/lib/server/respond'
import { normalizeEmail } from '@/lib/members/member'
import { createInvite, generateInviteToken } from '@/lib/members/invite'
import { memberSummary } from '@/lib/members/summary'

export async function GET(request: Request) {
  await connection()
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  if (auth.actor.role !== 'owner') return json({ error: 'forbidden' }, 403)
  const now = new Date().toISOString()
  return json((await membersStore().list()).map(member => memberSummary(member, now)))
}

export async function POST(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  if (auth.actor.role !== 'owner') return json({ error: 'forbidden' }, 403)
  const body = await readJson(request)
  if (!body || Object.keys(body).some(key => key !== 'email' && key !== 'role') || typeof body.email !== 'string' || (body.role !== 'editor' && body.role !== 'owner')) return badRequest()
  const email = normalizeEmail(body.email)
  if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) return badRequest()
  const token = generateInviteToken()
  const now = new Date().toISOString()
  const store = membersStore()
  const result = await store.create({ email, role: body.role, signIn: 'google', invitedBy: auth.actor.uid, invite: createInvite(token, () => now) })
  if (result === 'exists') return json({ error: 'member_exists' }, 409)
  const member = await store.getByEmail(email)
  if (!member) return json({ error: 'unavailable' }, 503)
  return json({ member: memberSummary(member, now), inviteUrl: `${new URL(request.url).origin}/invite/${token}` }, 201)
}
