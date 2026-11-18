import type { Firestore } from '@google-cloud/firestore'
import { expect, test, vi } from 'vitest'
import { firestoreCatalogSource } from '../../lib/catalog/firestore-source'
import { fixtureSource } from '../../lib/catalog/fixture-source'

test('reads the current pointer without loading the snapshot and sees pointer changes', async () => {
  let version: unknown = 11
  const db = { doc: vi.fn(() => ({ /** Return a simulated Firestore catalog pointer document. */ get: async () => ({ /** Expose the fixture version through the simulated document's field accessor. */ get: () => version }) })) }
  const load = vi.fn()
  const source = firestoreCatalogSource(db as unknown as Firestore, load)
  expect(await source.readVersion()).toBe(11)
  version = 12
  expect(await source.readVersion()).toBe(12)
  expect(load).not.toHaveBeenCalled()
  expect(db.doc).toHaveBeenCalledWith('config/catalog')
  version = null
  await expect(source.readVersion()).rejects.toThrow('config/catalog has no numeric version')
})

test('fixture pointer matches the fixture catalog version', async () => {
  expect(await fixtureSource().readVersion()).toBe(11)
})
