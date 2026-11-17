import { grantLiveAccess } from '../../../lib/live/access'
import { currentActor, liveAccessDeps } from '../../../lib/server/context'
import { json } from '../../../lib/server/respond'

export async function POST(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  return json(await grantLiveAccess(liveAccessDeps(), auth.actor.uid))
}
