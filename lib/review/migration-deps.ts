import { orderedStatePlates } from '../catalog/order'
import type { CatalogSource, Plate, Snapshot } from '../catalog/types'
import type { ReviewDeps, ReviewStore } from './types'

/**
 * Review dependencies for a command-line run. The app's baseline readers cache
 * catalog slices through the Next.js remote cache, which only exists inside the Next
 * runtime, so a script loads each whole versioned snapshot once and indexes it in
 * memory instead.
 */
export function snapshotReviewDeps(
  store: ReviewStore,
  source: CatalogSource,
  loadVersion: (version: number) => Promise<Snapshot>,
  now: () => string = () => new Date().toISOString()
): ReviewDeps & { liveVersion(): Promise<number> } {
  const loaded = new Map<
    number,
    Promise<{ snapshot: Snapshot; byId: Map<string, Plate> }>
  >()
  /** Load one snapshot version and its plate index, sharing the promise per version. */
  const version = (number: number) => {
    let entry = loaded.get(number)
    if (!entry) {
      entry = loadVersion(number).then((snapshot) => {
        if (snapshot.version !== number)
          throw new Error(`Catalog v${number} unavailable`)
        return {
          snapshot,
          byId: new Map(snapshot.plates.map((plate) => [plate.id, plate])),
        }
      })
      loaded.set(number, entry)
    }
    return entry
  }
  return {
    store,
    liveVersion: () => source.readVersion(),
    async baseline(plateId) {
      return (
        (await version(await source.readVersion())).byId.get(plateId) ?? null
      )
    },
    async baselineAtVersion(number, plateId) {
      return (await version(number)).byId.get(plateId) ?? null
    },
    async stateBaseline(number, state, order) {
      const { snapshot } = await version(number)
      return orderedStatePlates(
        snapshot,
        state,
        order === 'snapshot'
          ? { stateOrder: {}, stateProgress: {} }
          : await source.readCuratorState()
      )
    },
    now,
  }
}
