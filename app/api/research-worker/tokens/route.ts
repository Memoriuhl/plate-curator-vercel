import { currentActiveOwner } from '@/lib/server/context'
import { researchDeps, readResearchJson } from '@/lib/server/research-context'
import { issueResearchWorkerToken } from '@/lib/research/tokens'

/**
 * Issue a research worker credential to an active owner and return the raw token only at
 * creation.
 */
export async function POST(request: Request) {
  const auth = await currentActiveOwner(request)
  if (!auth.ok) return auth.response
  const body = await readResearchJson(request)
  if (typeof body?.workerId !== 'string' || !body.workerId.trim() || body.workerId.length > 64) return Response.json({ error: 'bad_request' }, { status: 400 })
  return Response.json(await issueResearchWorkerToken((await researchDeps()).store, body.workerId), { headers: { 'Cache-Control': 'no-store' } })
}
