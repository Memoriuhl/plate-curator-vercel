import catalog from '../../fixtures/catalog-demo.json'
import curator from '../../fixtures/curator-state-demo.json'
import { plateImageUrl } from './image-url'
import type { CatalogSource, Snapshot } from './types'

export function fixtureSource(imageBase: string | null = null): CatalogSource {
  return {
    async readVersion() {
      return catalog.version
    },
    async readSnapshot() {
      return structuredClone(catalog) as Snapshot
    },
    async readCuratorState() {
      return structuredClone(curator)
    },
    imageUrl(plate) {
      return plateImageUrl(plate, imageBase)
    },
  }
}
