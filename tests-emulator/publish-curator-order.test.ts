import { afterAll, beforeEach } from 'vitest'
import {
  curatorOrderScenarios,
  type WorkflowOrders,
} from '../tests/publish/curator-order-scenarios'
import { snapshot } from '../tests/publish/fixture'
import {
  cleanupRelease,
  env,
  releaseFixture,
  resetRelease,
} from './release-fixture'
import { db } from './setup'
import { sha256, snapshotBytes } from '../lib/publish/snapshots/bytes'

beforeEach(resetRelease)
afterAll(cleanupRelease)

curatorOrderScenarios(async () => {
  const f = releaseFixture()
  f.blobs.set(
    1,
    Buffer.from(
      JSON.stringify({
        ...snapshot,
        plates: [
          ...snapshot.plates,
          ...['ny-one', 'ny-two'].map((id) => ({
            ...snapshot.plates[0],
            id,
            slug: id,
            state: 'NY',
          })),
        ],
      })
    )
  )
  return {
    deps: f.deps,
    /** Read the curator ordering document that publishing is expected to update. */
    workflow: async () =>
      (await db.doc('curator/workflow').get()).data() as WorkflowOrders,
    /**
     * Seed the curator's state order and version before projecting a published release.
     */
    seedWorkflow: async (value) => {
      await db.doc('curator/workflow').set(value)
    },
    /**
     * Set the emulator's live pointer with the snapshot checksum required by the
     * projection.
     */
    setLive: async (value) => {
      const bytes = snapshotBytes(value)
      f.blobs.set(value.version, bytes)
      await db
        .doc('config/catalog')
        .set({ version: value.version, blobSha256: sha256(bytes) })
    },
    /** Store a scoped publish receipt for the curator order test. */
    seedReceipt: async (value) => {
      await db.doc('publishRecords/' + value.id).set({ ...value, env })
    },
  }
})
