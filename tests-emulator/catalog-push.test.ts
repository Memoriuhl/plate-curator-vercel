import { afterAll, expect, test } from 'vitest'
import { firestoreCatalogPushStore } from '../lib/publish/catalog-push'
import { db } from './setup'

test('queries only user devices, claims atomically and prunes without deleting a renewed token', async () => {
  const path = 'users/push-test/devices/phone'
  const other = 'other/push-test/devices/phone'
  const store = firestoreCatalogPushStore(db)
  await db.doc(path).set({ expoPushToken: 'ExpoPushToken[test]' })
  await db.doc(other).set({ expoPushToken: 'ExpoPushToken[other]' })
  await db
    .doc('users/push-test/devices/invalid')
    .set({ expoPushToken: 'invalid' })
  try {
    expect(await store.devices()).toEqual([
      { path, token: 'ExpoPushToken[test]' },
    ])
    expect(
      (await Promise.all([store.claim(987654), store.claim(987654)])).sort()
    ).toEqual([false, true])
    await store.finish(987654, {
      status: 'completed',
      sent: 1,
      failed: 0,
      pruned: 0,
    })
    expect((await db.doc('catalogPushes/987654').get()).get('sent')).toBe(1)
    await db.doc(path).update({ expoPushToken: 'ExpoPushToken[new]' })
    await store.prune({ path, token: 'ExpoPushToken[test]' })
    expect((await db.doc(path).get()).exists).toBe(true)
    await store.prune({ path, token: 'ExpoPushToken[new]' })
    expect((await db.doc(path).get()).exists).toBe(false)
  } finally {
    await Promise.all([
      db.doc(path).delete(),
      db.doc(other).delete(),
      db.doc('users/push-test/devices/invalid').delete(),
      db.doc('catalogPushes/987654').delete(),
    ])
  }
})

afterAll(() => db.terminate())
