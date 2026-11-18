import { isPublishStop } from '@/lib/publish/stop'
import { currentActiveOwner, publishAllowed, publishControl } from '@/lib/server/context'
import { badRequest, json, readJson } from '@/lib/server/respond'

export async function GET(request: Request) {
  try {
    const auth = await currentActiveOwner(request)
    if (!auth.ok) return auth.response
    return json({ control: await publishControl().read(), enabledHere: publishAllowed() })
  } catch {
    return json({ error: 'unavailable' }, 503)
  }
}

export async function POST(request: Request) {
  try {
    const auth = await currentActiveOwner(request)
    if (!auth.ok) return auth.response
    if (!publishAllowed()) return json({ error: 'publish_disabled_here' }, 403)
    const body = await readJson(request)
    if (typeof body?.paused !== 'boolean' || Object.keys(body).some(key => key !== 'paused')) return badRequest()
    const control = await publishControl().change(body.paused, { uid: auth.actor.uid, email: auth.actor.email }, new Date().toISOString())
    if (isPublishStop(control)) return json({ error: control }, 409)
    return control ? json({ control }) : json({ error: 'forbidden' }, 403)
  } catch {
    return json({ error: 'unavailable' }, 503)
  }
}
