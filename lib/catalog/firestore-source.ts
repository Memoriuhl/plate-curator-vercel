import type { Firestore } from '@google-cloud/firestore'
import { plateImageUrl } from './image-url'
import type { CatalogSource, Snapshot } from './types'

/**
 * Build the live catalog reader using the Firestore pointer and the supplied snapshot
 * loader.
 */
export function firestoreCatalogSource(
  db: Firestore,
  loadSnapshot: (version: number) => Promise<Snapshot>,
  imageBase: string | null = null
): CatalogSource {
  /**
   * Read the current catalog pointer and reject versions that cannot identify a
   * snapshot.
   */
  const readVersion = async () => {
    const pointer = await db.doc('config/catalog').get()
    const version = pointer.get('version')
    if (typeof version !== 'number')
      throw new Error('config/catalog has no numeric version')
    return version
  }
  return {
    readVersion,
    /** Load the snapshot referenced by the current Firestore catalog pointer. */
    async readSnapshot() {
      return loadSnapshot(await readVersion())
    },
    /**
     * Read the curator's saved state order and progress, with defaults for older data.
     */
    async readCuratorState() {
      const snapshot = await db.doc('curator/workflow').get()
      const state = snapshot.data()
      return {
        stateOrder: state?.stateOrder ?? {},
        stateProgress: state?.stateProgress ?? {},
      }
    },
    /** Resolve a catalog plate image using this source's configured image base. */
    imageUrl(plate) {
      return plateImageUrl(plate, imageBase)
    },
  }
}
