import type { Firestore } from '@google-cloud/firestore'
import type { CatalogSource, Snapshot } from './types'

export function firestoreCatalogSource(
  db: Firestore,
  loadSnapshot: (version: number) => Promise<Snapshot>,
): CatalogSource {
  return {
    async readSnapshot() {
      const pointer = await db.doc('config/catalog').get()
      const version = pointer.get('version')
      if (typeof version !== 'number') throw new Error('config/catalog has no numeric version')
      return loadSnapshot(version)
    },
    async readCuratorState() {
      const snapshot = await db.doc('curator/workflow').get()
      const state = snapshot.data()
      return { stateOrder: state?.stateOrder ?? {}, stateProgress: state?.stateProgress ?? {} }
    },
    imageUrl(plate) {
      return typeof plate.imageUrl === 'string' && plate.imageUrl.length > 0 ? plate.imageUrl : null
    },
  }
}
