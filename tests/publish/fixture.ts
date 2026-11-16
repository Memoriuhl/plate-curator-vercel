import { createHash } from 'node:crypto'
import type { Snapshot } from '../../lib/catalog/types'
import { createMemoryStore } from '../../lib/review/memory-store'
import type { ReviewBatch } from '../../lib/review/types'
import type { CatalogPointer, PublishDeps, PublishLease, PublishRecord } from '../../lib/publish/types'

export const owner = { uid: 'owner', name: null, role: 'owner' } as const
export const batch: ReviewBatch = {
  stateOrders: {},
  id: 'batch', name: 'Release', createdBy: 'editor', createdByName: null, createdAt: '2026-11-15T12:00:00Z',
  state: 'approved', revision: 2, baselineVersion: 1, plateIds: ['one'],
  approval: { revision: 1, by: owner.uid, at: '2026-11-15T12:00:00Z' },
}
export const command = { batchId: batch.id, revision: batch.revision }
export const snapshot: Snapshot = { version: 1, plates: [
  { id: 'one', state: 'CA', slug: 'one', displayName: 'One', image: 'one.png', tags: ['original'] },
  { id: 'two', state: 'CA', slug: 'two', displayName: 'Two', image: 'two.png', tags: [] },
] }

export function fixture(seed: ReviewBatch = batch) {
  const store = createMemoryStore([seed])
  const blobs = new Map<number, Uint8Array>([[1, Buffer.from(JSON.stringify(snapshot))]])
  const records = new Map<string, PublishRecord>()
  const stateOrder: Record<string, string[]> = { NY: ['existing'] }
  let pointer: CatalogPointer = { version: 1 }
  let lease: PublishLease | null = null
  let reservation: string | null = null
  let time = '2026-11-15T12:00:00Z'
  const active = (token: string, now: string) => lease?.token === token && Date.parse(lease.expiresAt) > Date.parse(now)
  const commit = store.commit.bind(store)
  store.commit = async (id, revision, next) => {
    if (reservation && (next.publishToken !== reservation || next.batch.state !== 'published')) return 'revision_mismatch'
    const result = await commit(id, revision, next)
    if (result === 'ok' && next.batch.state === 'published') reservation = null
    return result
  }
  const deps: PublishDeps = {
    stateBaseline: async (_version, state) => snapshot.plates.filter(plate => plate.state === state),
    store, baseline: async id => snapshot.plates.find(plate => plate.id === id) ?? null,
    now: () => time, leaseMs: 60000,
    curator: {
      writeStateOrders: async (orders, claim, now) => {
        if (!active(claim.token, now) || lease?.batchId !== claim.batchId || lease.revision !== claim.revision) return 'lock_lost'
        Object.assign(stateOrder, structuredClone(orders))
        return 'ok'
      },
    },
    pointer: {
      read: async () => structuredClone(pointer),
      advance: async (record, claim, now) => {
        if (!active(claim.token, now)) return 'lock_lost'
        const current = await store.getBatch(record.batchId)
        if (current?.revision !== record.revision || current.state !== 'approved') return 'superseded_revision'
        const saved = records.get(record.id)
        if (saved?.committedAt) return 'advanced'
        if (pointer.version !== record.fromVersion) return 'pointer_moved'
        if (!record.url) return 'superseded_revision'
        pointer = { version: record.toVersion, url: record.url, blobSha256: record.blobSha256, publishedAt: now }
        records.set(record.id, { ...record, committedAt: now })
        return 'advanced'
      },
    },
    snapshots: {
      read: async version => JSON.parse(Buffer.from(blobs.get(version)!).toString()) as Snapshot,
      createOnly: async (version, bytes) => {
        if (blobs.has(version)) return 'exists'
        blobs.set(version, Uint8Array.from(bytes))
        return 'created'
      },
      checksum: async version => blobs.has(version) ? createHash('sha256').update(blobs.get(version)!).digest('hex') : null,
      downloadUrl: async version => blobs.has(version) ? `https://storage.example/v${version}.json?token=t${version}` : null,
    },
    records: {
      get: async id => structuredClone(records.get(id) ?? null),
      save: async (record, token, now) => {
        if (!active(token, now)) return false
        records.set(record.id, structuredClone({ ...records.get(record.id), ...record }))
        return true
      },
    },
    lock: {
      claim: async (claim, now) => {
        if (lease && Date.parse(lease.expiresAt) > Date.parse(now)) return false
        const current = await store.getBatch(claim.batchId)
        if (current?.state !== 'approved' || current.revision !== claim.revision) return false
        lease = structuredClone(claim)
        reservation = claim.token
        return true
      },
      renew: async (claim, now) => {
        if (!active(claim.token, now)) return false
        lease = structuredClone(claim)
        return true
      },
      release: async (token, keepFrozen) => {
        if (lease?.token !== token) return
        if (!keepFrozen) reservation = null
        lease = null
      },
    },
  }
  return { deps, blobs, records, stateOrder, pointer: () => pointer, lease: () => lease, setTime: (value: string) => { time = value } }
}
