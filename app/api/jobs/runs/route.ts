import { connection } from 'next/server'
import { listGatewayRuns } from '../../../../lib/jobs/gateway-runs'
import { currentActor, jobsDeps } from '../../../../lib/server/context'
import { json } from '../../../../lib/server/respond'

export async function GET(request: Request) {
  await connection()
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const deps = jobsDeps()
  return json({ runs: await listGatewayRuns(deps, auth.actor), observedAt: deps.now() })
}
