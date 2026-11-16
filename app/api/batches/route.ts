import { parseBatchInput } from '../../../lib/review/fields'
import { createBatch, listBatches } from '../../../lib/review/queries'
import type { BatchState } from '../../../lib/review/types'
import { catalog, currentActor, reviewDeps } from '../../../lib/server/context'
import { badRequest, json, readJson, respond } from '../../../lib/server/respond'

const states: BatchState[] = ['open', 'submitted', 'approved', 'published', 'conflict']

export async function GET(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const requested = new URL(request.url).searchParams.get('state')?.split(',') ?? undefined
  if (requested?.some((state) => !states.includes(state as BatchState))) return badRequest()

  return json(await listBatches(reviewDeps(), { states: requested as BatchState[] | undefined }))
}

export async function POST(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const input = parseBatchInput(await readJson(request))
  if (input === null) return badRequest()

  const snapshot = await catalog().readSnapshot()
  const known = new Set(snapshot.plates.map((plate) => plate.id))
  if (!input.plateIds.every((id) => known.has(id))) return json({ error: 'not_found' }, 404)

  return respond(await createBatch(reviewDeps(), auth.actor, {
    id: crypto.randomUUID(),
    name: input.name,
    plateIds: input.plateIds,
    baselineVersion: snapshot.version,
  }))
}
