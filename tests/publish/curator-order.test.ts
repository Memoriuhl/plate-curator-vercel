import { curatorOrderScenarios } from './curator-order-scenarios'
import { fixture, snapshot } from './fixture'
import { sha256, snapshotBytes } from '../../lib/publish/bytes'

curatorOrderScenarios(async () => {
  const f = fixture()
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
    /**
     * Read a detached copy of the in-memory curator order and per-state release
     * versions.
     */
    workflow: async () =>
      structuredClone({
        stateOrder: f.stateOrder,
        stateOrderVersion: f.stateOrderVersion,
      }),
    /** Replace the curator fixture data with the supplied order and version markers. */
    seedWorkflow: async (value) => {
      for (const state of Object.keys(f.stateOrder)) delete f.stateOrder[state]
      for (const state of Object.keys(f.stateOrderVersion))
        delete f.stateOrderVersion[state]
      Object.assign(f.stateOrder, structuredClone(value.stateOrder))
      Object.assign(
        f.stateOrderVersion,
        structuredClone(value.stateOrderVersion ?? {})
      )
    },
    /**
     * Set the in-memory live pointer with bytes and checksum consistent with the
     * supplied snapshot.
     */
    setLive: async (value) => {
      const bytes = snapshotBytes(value)
      f.blobs.set(value.version, bytes)
      Object.assign(f.pointer(), {
        version: value.version,
        blobSha256: sha256(bytes),
      })
    },
    /** Seed a detached release receipt into the in-memory publish store. */
    seedReceipt: async (value) => {
      f.records.set(value.id, structuredClone(value))
    },
  }
})
