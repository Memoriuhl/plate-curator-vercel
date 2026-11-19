import { connection } from 'next/server'
import { currentActor } from '../../../../lib/server/context'
import {
  searchProviderEnvironment,
  searchProviderHealth,
} from '../../../../lib/research/provider-health'
import { json } from '../../../../lib/server/respond'

/**
 * Report which web search providers this deployment can use, and why any cannot.
 * Owners only. `?probe=1` spends one search per configured provider; key values are
 * never returned.
 */
export async function GET(request: Request) {
  await connection()
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  if (auth.actor.role !== 'owner') return json({ error: 'forbidden' }, 403)
  return json(
    await searchProviderHealth({
      ...searchProviderEnvironment(),
      probe: new URL(request.url).searchParams.get('probe') === '1',
    })
  )
}
