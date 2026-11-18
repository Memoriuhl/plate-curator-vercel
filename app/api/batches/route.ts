import { connection } from 'next/server'
import { parseBatchInput } from '../../../lib/review/fields'
import {
  createBatch,
  dashboardDrafts,
  listBatches,
} from '../../../lib/review/queries'
import type { BatchState } from '../../../lib/review/types'
import { catalogChanged } from '../../../lib/server/catalog-head'
import { catalog, currentActor, reviewDeps } from '../../../lib/server/context'
import {
  badRequest,
  json,
  readJson,
  respond,
} from '../../../lib/server/respond'

const states: BatchState[] = [
  'open',
  'submitted',
  'approved',
  'published',
  'conflict',
]

/**
 * List batches visible to the signed-in actor using the requested state and creator
 * filters.
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
        auth.actor,
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

/** Validate requested plate IDs against the catalog before creating a new batch. */
export async function POST(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const input = parseBatchInput(await readJson(request))
  if (input === null) return badRequest()

  const snapshot = await catalog().readSnapshot()
  const known = new Set(snapshot.plates.map((plate) => plate.id))
  if (!input.plateIds.every((id) => known.has(id)))
    return json({ error: 'not_found' }, 404)

  const outcome = await createBatch(reviewDeps(), auth.actor, {
    id: crypto.randomUUID(),
    name: input.name,
    plateIds: input.plateIds,
    baselineVersion: snapshot.version,
  })
  if (outcome.ok) catalogChanged()
  return respond(outcome)
}
