import { expect, test, vi } from 'vitest'
import type { Firestore } from '@google-cloud/firestore'
import { firestoreJobsStore } from '../../lib/jobs/firestore-store'

test('local jobs use their own environment while reading only the configured review environment', async () => {
  const get = vi.fn(async (ref: { path?: string; query?: string[] }) => {
    if (ref.query) return { docs: [] }
    return { exists: true, get: (key: string) => key === 'env' ? 'development' : key === 'baselineVersion' ? 42 : key === 'fields' ? { description: 'Draft' } : undefined }
  })
  const document = (path: string): unknown => ({ path, collection: (name: string) => ({ doc: (id: string) => document(`${path}/${name}/${id}`) }) })
  const where = vi.fn((_field: string, _op: string, value: string) => ({ query: ['env', value] }))
  const db = { collection: (name: string) => ({ doc: (id: string) => document(`${name}/${id}`), where }), runTransaction: (run: (tx: object) => unknown) => run({ get }) } as unknown as Firestore
  const store = firestoreJobsStore(db, 'preview:local-pipeline-test', 'development')
  expect(await store.transaction(tx => tx.review('own-batch', 'AK.one'))).toEqual({ baselineVersion: 42, fields: { description: 'Draft' } })
  await store.transaction(tx => tx.list())
  expect(where).toHaveBeenCalledWith('env', '==', 'preview:local-pipeline-test')
  expect(get.mock.calls[0][0]).toMatchObject({ path: 'reviewBatches/own-batch' })
  expect(await firestoreJobsStore(db, 'preview:local-pipeline-test').transaction(tx => tx.review('own-batch', 'AK.one'))).toBeNull()
})
