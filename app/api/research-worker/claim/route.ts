import { researchDeps } from '@/lib/server/research-context'
import { researchWorkerIdentity } from '@/lib/research/tokens'
import { claimResearch } from '@/lib/research/jobs'

/** Authenticate a research worker and lease its next eligible job. */
export async function POST(request: Request) {
  const deps = await researchDeps()
  const worker = await researchWorkerIdentity(deps.store, request)
  if (!worker)
    return Response.json({ error: 'unauthenticated' }, { status: 401 })
  const claim = await claimResearch(deps, worker)
  // Leases change on each claim. A worker must get the current response from the server.
  return claim
    ? Response.json(claim, { headers: { 'Cache-Control': 'no-store' } })
    : new Response(null, { status: 204 })
}
