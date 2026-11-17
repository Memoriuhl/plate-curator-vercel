import { afterAll, beforeEach } from 'vitest'
import { curatorOrderScenarios, type WorkflowOrders } from '../tests/publish/curator-order-scenarios'
import { snapshot } from '../tests/publish/fixture'
import { cleanupRelease, env, releaseFixture, resetRelease } from './release-fixture'
import { db } from './setup'
import { sha256, snapshotBytes } from '../lib/publish/bytes'

beforeEach(resetRelease)
afterAll(cleanupRelease)

curatorOrderScenarios(async () => {
  const f = releaseFixture()
  f.blobs.set(1, Buffer.from(JSON.stringify({ ...snapshot, plates: [...snapshot.plates, ...['ny-one', 'ny-two'].map(id => ({ ...snapshot.plates[0], id, slug: id, state: 'NY' }))] })))
  return {
    deps: f.deps,
    workflow: async () => (await db.doc('curator/workflow').get()).data() as WorkflowOrders,
    seedWorkflow: async value => { await db.doc('curator/workflow').set(value) },
    setLive: async value => {
      const bytes = snapshotBytes(value)
      f.blobs.set(value.version, bytes)
      await db.doc('config/catalog').set({ version: value.version, blobSha256: sha256(bytes) })
    },
    seedReceipt: async value => { await db.doc('publishRecords/' + value.id).set({ ...value, env }) },
  }
})
