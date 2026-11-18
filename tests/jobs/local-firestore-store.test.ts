import { expect, test, vi } from 'vitest'
import type { Firestore } from '@google-cloud/firestore'
import { firestoreJobsStore } from '../../lib/jobs/firestore-store'
import type { WorkerCapabilityRecord } from '../../lib/jobs/capabilities'

test('local jobs use their own environment while reading only the configured review environment', async () => {
  const get = vi.fn(async (ref: { path?: string; query?: string[] }) => {
    if (ref.query) return { docs: [] }
    if (ref.path?.includes('/edits/')) return { exists: true, data: () => ({ plateId: 'AK.one', fields: { description: 'Draft' } }) }
    return { exists: true, get: (key: string) => key === 'env' ? 'development' : key === 'baselineVersion' ? 42 : undefined }
  })
  const document = (path: string): unknown => ({ path, collection: (name: string) => ({ doc: (id: string) => document(`${path}/${name}/${id}`) }) })
  const where = vi.fn((_field: string, _op: string, value: string) => ({ query: ['env', value] }))
  const db = { collection: (name: string) => ({ doc: (id: string) => document(`${name}/${id}`), where }), runTransaction: (run: (tx: object) => unknown) => run({ get }) } as unknown as Firestore
  const store = firestoreJobsStore(db, 'preview:local-pipeline-test', 'development')
  expect(await store.transaction(tx => tx.review('own-batch', 'AK.one'))).toMatchObject({ baselineVersion: 42, fields: { description: 'Draft' } })
  await store.transaction(tx => tx.list())
  expect(where).toHaveBeenCalledWith('env', '==', 'preview:local-pipeline-test')
  expect(get.mock.calls[0][0]).toMatchObject({ path: 'reviewBatches/own-batch' })
  expect(await firestoreJobsStore(db, 'preview:local-pipeline-test').transaction(tx => tx.review('own-batch', 'AK.one'))).toBeNull()
})

test('capability storage skips duplicate writes within a poll interval and records changes immediately', async () => {
  let stored: WorkerCapabilityRecord | null = null
  const set = vi.fn((_ref: unknown, record: WorkerCapabilityRecord) => { stored = structuredClone(record) })
  const db = {
    collection: () => ({ doc: (id: string) => ({ id }) }),
    runTransaction: (run: (tx: object) => unknown) => run({ get: async () => ({ exists: stored !== null, data: () => stored }), set }),
  } as unknown as Firestore
  const store = firestoreJobsStore(db, 'development')
  const record: WorkerCapabilityRecord = { workerId: 'worker', reportedAt: 1000, capabilities: { group: { available: true }, embeddings: { available: true }, mask: { available: true }, vision: { available: false, reason: 'Unavailable' }, pollIntervalMs: 5000 } }
  await store.writeCapabilities('scope', record)
  await store.writeCapabilities('scope', { ...record, reportedAt: 5999 })
  expect(set).toHaveBeenCalledTimes(1)
  expect(set.mock.lastCall?.[1].reportedAt).toBe(1000)
  await store.writeCapabilities('scope', { ...record, reportedAt: 6000 })
  expect(set).toHaveBeenCalledTimes(2)
  const changed = { ...record, reportedAt: 6001, capabilities: { ...record.capabilities, vision: { available: true } } }
  await store.writeCapabilities('scope', changed)
  expect(set).toHaveBeenCalledTimes(3)
  await store.writeCapabilities('scope', { ...changed, workerId: 'replacement', reportedAt: 6002 })
  expect(set).toHaveBeenCalledTimes(4)
  await store.writeCapabilities('scope', record)
  expect(set).toHaveBeenCalledTimes(4)
})
