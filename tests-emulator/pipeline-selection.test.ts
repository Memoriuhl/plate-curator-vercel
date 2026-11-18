import { Firestore } from '@google-cloud/firestore'
import { afterAll, expect, test, vi } from 'vitest'
import { firestoreJobsStore } from '../lib/jobs/firestore-store'
import { localJobsEnvironment } from '../lib/jobs/local-scope'
import { enqueueSelection, listRuns } from '../lib/jobs/queue'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import type { Plate } from '../lib/catalog/types'

const host = process.env.FIRESTORE_EMULATOR_HOST
if (!host || !/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host)) throw Error('Selection persistence tests require a localhost emulator')
const db = new Firestore({ projectId: 'demo-pcv-batch-selection' })

afterAll(async () => {
  for (const collection of ['reviewBatches', 'localPipelineRuns', 'liveSignals']) {
    await db.recursiveDelete(db.collection(collection))
  }
  await db.terminate()
})

test('a concurrent retry of a 990-plate selection creates one Batch with a durable run for every chunk', async () => {
  const id = 'state-scale-batch'
  const env = 'development'
  const scope = 'state-scale'
  const actor = { uid: 'curator', name: 'Curator', role: 'editor' as const }
  const catalog = new Map<string, Plate>(Array.from({ length: 990 }, (_, index) => {
    const slug = `plate_${index}`
    const id = `MD.${slug}`
    return [id, { id, state: 'MD', slug, displayName: `Plate ${index}`, image: '', tags: [] }]
  }))
  const plateIds = [...catalog.keys()]
  const deps = { store: firestoreJobsStore(db, localJobsEnvironment(scope), env), localScope: scope,
    baseline: async (id: string) => catalog.get(id) ?? null, id: () => crypto.randomUUID(), now: Date.now, leaseMs: 1000 }
  const input = { batchId: id, requestId: 'state-scale-request', plateIds, stages: ['wiki-link' as const] }
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  try {
    const draft = { name: 'Maryland pipeline', baselineVersion: 3 }
    const results = await Promise.all([enqueueSelection(deps, actor, input, draft), enqueueSelection(deps, actor, input, draft)])
    for (const result of results) {
      if (!result.ok) throw Error(result.error)
      expect(result.value.flatMap(run => run.plateIds)).toEqual(plateIds)
    }
    const [first, second] = results
    if (!first.ok || !second.ok) throw Error('Both requests should succeed')
    expect(first.value.map(run => run.id)).toEqual(second.value.map(run => run.id))

    const restored = { ...deps, store: firestoreJobsStore(db, localJobsEnvironment(scope), env) }
    const queue = await listRuns(restored, actor)
    if (!queue.ok) throw Error(queue.error)
    expect(queue.value).toHaveLength(first.value.length)
    const batches = await firestoreReviewStore(db, env).list({})
    expect(batches).toEqual([expect.objectContaining({ id, name: draft.name, plateIds })])
  } finally {
    vi.unstubAllEnvs()
  }
}, 30_000)
