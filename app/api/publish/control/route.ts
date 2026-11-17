import { currentActor, publishAllowed, publishControl } from '@/lib/server/context'
import { membersStore } from '@/lib/server/members'
import { isActiveOwner } from '@/lib/members/member'
import { badRequest, json, readJson } from '@/lib/server/respond'

async function owner(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return { response: auth.response }
  if (auth.actor.role !== 'owner') return { response: json({ error: 'forbidden' }, 403) }
  const member = await membersStore().getByUid(auth.actor.uid)
  if (!member || !isActiveOwner(member)) return { response: json({ error: 'forbidden' }, 403) }
  return { actor: { uid: auth.actor.uid, email: member.email } }
}

export async function GET(request: Request) {
  try {
    const auth = await owner(request)
    if (auth.response) return auth.response
    return json({ control: await publishControl().read() })
  } catch {
    return json({ error: 'unavailable' }, 503)
  }
}

export async function POST(request: Request) {
  try {
    const auth = await owner(request)
    if (auth.response) return auth.response
    if (!publishAllowed()) return json({ error: 'publish_disabled_here' }, 403)
    const body = await readJson(request)
    if (typeof body?.paused !== 'boolean' || Object.keys(body).some(key => key !== 'paused')) return badRequest()
    const control = await publishControl().change(body.paused, auth.actor!, new Date().toISOString())
    return control ? json({ control }) : json({ error: 'forbidden' }, 403)
  } catch {
    return json({ error: 'unavailable' }, 503)
  }
}
