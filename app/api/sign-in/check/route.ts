import { memberStatus, normalizeEmail } from '@/lib/members/member'
import { membersStore } from '@/lib/server/members'
import { badRequest, json, readJson } from '@/lib/server/respond'

/** Look up whether the submitted email has a pending or active invitation for sign-in. */
export async function POST(request: Request) {
  const body = await readJson(request)
  if (!body || Object.keys(body).some(key => key !== 'email') || typeof body.email !== 'string') return badRequest()
  const email = normalizeEmail(body.email)
  if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) return badRequest()
  const member = await membersStore().getByEmail(email)
  return json(member
    ? { invited: true, signIn: member.signIn, status: memberStatus(member, new Date().toISOString()) }
    : { invited: false })
}
