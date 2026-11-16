import catalog from '../../fixtures/catalog-demo.json'
import curator from '../../fixtures/curator-state-demo.json'
import type { CatalogSource, Snapshot } from './types'

export function fixtureSource(): CatalogSource {
  return {
    async readSnapshot() {
      return structuredClone(catalog) as Snapshot
    },
    async readCuratorState() {
      return structuredClone(curator)
    },
    imageUrl(plate) {
      return typeof plate.imageUrl === 'string' && plate.imageUrl.length > 0 ? plate.imageUrl : null
    },
  }
}
