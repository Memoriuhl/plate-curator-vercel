import type { Firestore } from '@google-cloud/firestore'
import { plateImageUrl } from './image-url'
import type { CatalogSource, Snapshot } from './types'

export function firestoreCatalogSource(
  db: Firestore,
  loadSnapshot: (version: number) => Promise<Snapshot>,
  imageBase: string | null = null,
): CatalogSource {
  const readVersion = async () => {
    const pointer = await db.doc('config/catalog').get()
    const version = pointer.get('version')
    if (typeof version !== 'number') throw new Error('config/catalog has no numeric version')
    return version
  }
  return {
    readVersion,
    async readSnapshot() {
      return loadSnapshot(await readVersion())
    },
    async readCuratorState() {
      const snapshot = await db.doc('curator/workflow').get()
      const state = snapshot.data()
      return { stateOrder: state?.stateOrder ?? {}, stateProgress: state?.stateProgress ?? {} }
    },
    imageUrl(plate) {
      return plateImageUrl(plate, imageBase)
    },
  }
}
