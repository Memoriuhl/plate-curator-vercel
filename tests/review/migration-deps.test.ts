import { expect, test, vi } from 'vitest'
import type { CatalogSource, Plate, Snapshot } from '../../lib/catalog/types'
import { createMemoryStore } from '../../lib/review/memory-store'
import { snapshotReviewDeps } from '../../lib/review/migration/migration-deps'

const plate = (id: string, tags: string[] = []): Plate => ({
  id,
  state: id.split('.')[0],
  slug: id,
  displayName: id,
  image: `${id}.png`,
  tags,
})
const versions: Record<number, Snapshot> = {
  1: { version: 1, plates: [plate('AK.one', ['old']), plate('AK.two')] },
  2: {
    version: 2,
    plates: [plate('AK.one', ['new']), plate('AK.two'), plate('AL.one')],
  },
}
const source: CatalogSource = {
  readVersion: async () => 2,
  readSnapshot: async () => versions[2],
  readCuratorState: async () => ({
    stateOrder: { AK: ['AK.two', 'AK.one'] },
    stateProgress: {},
  }),
  imageUrl: () => null,
}

test('reads baselines from whole versioned snapshots, loading each version once', async () => {
  const load = vi.fn(async (version: number) => versions[version])
  const d = snapshotReviewDeps(createMemoryStore([]), source, load)
  expect(await d.liveVersion()).toBe(2)
  expect((await d.baseline('AK.one'))?.tags).toEqual(['new'])
  expect((await d.baselineAtVersion(1, 'AK.one'))?.tags).toEqual(['old'])
  expect(await d.baselineAtVersion(1, 'AL.one')).toBeNull()
  expect(
    (await d.stateBaseline(2, 'AK')).map((entry: Plate) => entry.id)
  ).toEqual(['AK.two', 'AK.one'])
  expect(
    (await d.stateBaseline(2, 'AK', 'snapshot')).map((entry: Plate) => entry.id)
  ).toEqual(['AK.one', 'AK.two'])
  expect(load.mock.calls.map(([version]) => version).sort()).toEqual([1, 2])
})

test('refuses a loader that answers with a different version', async () => {
  const d = snapshotReviewDeps(createMemoryStore([]), source, async () => ({
    ...versions[2],
  }))
  await expect(d.baselineAtVersion(1, 'AK.one')).rejects.toThrow(
    'Catalog v1 unavailable'
  )
})
