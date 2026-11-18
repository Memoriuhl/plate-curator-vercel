import { currentActor, jobsDeps } from '@/lib/server/context'
import { json } from '@/lib/server/respond'
import { readLocalWorkerCapabilities } from '@/lib/jobs/capabilities'

/**
 * Return the scoped local worker's capabilities and heartbeat state when the feature is
 * enabled.
 */
export async function GET(request: Request) {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1') return json({ error: 'not_found' }, 404)
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  return json(await readLocalWorkerCapabilities(jobsDeps()))
}
