import { afterAll, expect, test } from 'vitest'
import { Timestamp } from '@google-cloud/firestore'
import { firestoreLiveAccessWriter } from '../lib/live/firestore-access'
import { db } from './setup'

afterAll(async () => { await db.recursiveDelete(db.collection('curatorLiveAccess')); await db.terminate() })

test('renewing a grant stores timestamps and preserves other environment grants', async () => {
  const write = firestoreLiveAccessWriter(db)
  await write('merge-member', 'development', new Date('2026-11-16T13:00:00.000Z'))
  await write('merge-member', 'preview%3Afeat%2Fx', new Date('2026-11-16T14:00:00.000Z'))
  await write('merge-member', 'development', new Date('2026-11-16T15:00:00.000Z'))
  expect((await db.doc('curatorLiveAccess/merge-member').get()).data()).toEqual({ envs: {
    development: Timestamp.fromDate(new Date('2026-11-16T15:00:00.000Z')),
    'preview%3Afeat%2Fx': Timestamp.fromDate(new Date('2026-11-16T14:00:00.000Z')),
  } })
})
