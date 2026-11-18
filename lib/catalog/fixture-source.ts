import catalog from '../../fixtures/catalog-demo.json'
import curator from '../../fixtures/curator-state-demo.json'
import { plateImageUrl } from './image-url'
import type { CatalogSource, Snapshot } from './types'

/** Provide the catalog source contract from local fixtures for demos and development. */
export function fixtureSource(imageBase: string | null = null): CatalogSource {
  return {
    /** Expose the pinned fixture version for callers that check for catalog changes. */
    async readVersion() {
      return catalog.version
    },
    /**
     * Return a detached copy of the fixture snapshot so edits stay local to the caller.
     */
    async readSnapshot() {
      return structuredClone(catalog) as Snapshot
    },
    /** Return independent curator state for ordering fixture plates. */
    async readCuratorState() {
      return structuredClone(curator)
    },
    /** Build plate image links using the fixture source's image base. */
    imageUrl(plate) {
      return plateImageUrl(plate, imageBase)
    },
  }
}
