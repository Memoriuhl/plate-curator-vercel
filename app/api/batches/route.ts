import { connection } from 'next/server'
import { SHARED_DRAFT_ALIAS } from '../../../lib/review/draft-id'
import { dashboardDrafts, listBatches } from '../../../lib/review/queries'
import type { BatchState } from '../../../lib/review/types'
import { currentActor, reviewDeps } from '../../../lib/server/context'
import { batchTarget } from '../../../lib/server/draft-target'
import { badRequest, json } from '../../../lib/server/respond'
import { batchStepRetired } from '../../../lib/server/retired'

const states: BatchState[] = [
  'open',
  'submitted',
  'approved',
  'published',
  'conflict',
  'folded',
]

/**
 * List batches visible to the signed-in actor using the requested state and creator
 * filters, or read the shared draft's overlay for the Dashboard's jurisdictions.
 */
export async function GET(request: Request) {
  await connection()
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const params = new URL(request.url).searchParams
  const dashboard = params.get('dashboard')
  if (dashboard !== null) {
    const jurisdictions = dashboard.split(',')
    if (
      jurisdictions.length > 100 ||
      jurisdictions.some((state) => !/^[A-Z]{2}$/.test(state))
    )
      return badRequest()
    return json({
      drafts: await dashboardDrafts(
        reviewDeps(),
        await batchTarget(SHARED_DRAFT_ALIAS, auth.actor),
        new Set(jurisdictions)
      ),
    })
  }
  const requested = params.get('state')?.split(',') ?? undefined
  if (requested?.some((state) => !states.includes(state as BatchState)))
    return badRequest()

  return json(
    await listBatches(reviewDeps(), {
      states: requested as BatchState[] | undefined,
      createdBy: params.get('mine') === '1' ? auth.actor.uid : undefined,
    })
  )
}

/** New Batches are retired: every change goes into the shared draft. */
export function POST() {
  return batchStepRetired()
}
