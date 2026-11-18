import { connection } from 'next/server'
import { listRunTimings } from '../../../../lib/jobs/run-timings'
import { currentActor, jobsDeps } from '../../../../lib/server/context'
import { json } from '../../../../lib/server/respond'

/** Return observed job timings for the signed-in actor's queue estimates. */
export async function GET(request: Request) {
  await connection()
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  return json(await listRunTimings(jobsDeps(), auth.actor))
}
