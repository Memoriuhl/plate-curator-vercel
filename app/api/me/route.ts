import { connection } from 'next/server'
import { sharedDraftId } from '../../../lib/review/draft-id'
import { currentActor, reviewEnv } from '../../../lib/server/context'
import { json } from '../../../lib/server/respond'

/**
 * Return the signed-in actor and current role for the session hooks, with the id of the
 * environment's shared draft that every edit goes into.
 */
export async function GET(request: Request) {
  await connection()
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  return json({ ...auth.actor, draftId: sharedDraftId(reviewEnv()) })
}
