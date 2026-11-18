import { connection } from 'next/server'
import { listGatewayRuns } from '../../../../lib/jobs/gateway-runs'
import { currentActor, jobsDeps } from '../../../../lib/server/context'
import { json } from '../../../../lib/server/respond'

/** List hosted tagging runs with an observation timestamp for the dashboard queue. */
export async function GET(request: Request) {
  await connection()
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const deps = jobsDeps()
  const unscoped = deps.localScope ? jobsDeps({ unscoped: true }) : undefined
  return json({
    runs: await listGatewayRuns(deps, auth.actor, unscoped),
    observedAt: deps.now(),
  })
}
