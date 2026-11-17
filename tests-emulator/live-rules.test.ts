import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, expect, test } from 'vitest'
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app'
import { collection, connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, getFirestore, setDoc, updateDoc, terminate } from 'firebase/firestore'
import { Timestamp } from '@google-cloud/firestore'
import { db } from './setup'

const clients: FirebaseApp[] = []
function client(uid?: string) {
  const app = initializeApp({ projectId: 'demo-plate-curator', apiKey: 'demo-key' }, randomUUID())
  clients.push(app)
  const firestore = getFirestore(app)
  const emulator = new URL(`http://${process.env.FIRESTORE_EMULATOR_HOST}`)
  connectFirestoreEmulator(firestore, emulator.hostname, Number(emulator.port), uid ? { mockUserToken: { sub: uid } } : undefined)
  return firestore
}
const path = 'curatorLive/preview%3Afeat%2Fx/batchRevisions/rules-batch'
const grant = db.doc('curatorLiveAccess/rules-member')

beforeEach(async () => {
  await db.doc(path).set({ revision: 7 })
  await db.doc('curatorLive/development/batchRevisions/rules-batch').set({ revision: 8 })
  await grant.set({ envs: { 'preview%3Afeat%2Fx': Timestamp.fromMillis(Date.now() + 60 * 60_000) } })
})

afterAll(async () => {
  for (const app of clients) { await terminate(getFirestore(app)); await deleteApp(app) }
  await db.recursiveDelete(db.collection('curatorLive'))
  await db.recursiveDelete(db.collection('curatorLiveAccess'))
  await db.terminate()
})

test('a signed-in member with a fresh environment grant can get only the revision', async () => {
  expect((await getDoc(doc(client('rules-member'), path))).data()).toEqual({ revision: 7 })
})

test.each([undefined, 'rules-non-member'])('denies identity %s without a grant even with a known batch id', async uid => {
  await expect(getDoc(doc(client(uid), path))).rejects.toMatchObject({ code: 'permission-denied' })
})

test('deleting the grant revokes a previously allowed member', async () => {
  const firestore = client('rules-member')
  expect((await getDoc(doc(firestore, path))).exists()).toBe(true)
  await grant.delete()
  await expect(getDoc(doc(firestore, path))).rejects.toMatchObject({ code: 'permission-denied' })
})

test('expired grants cannot read', async () => {
  await grant.set({ envs: { 'preview%3Afeat%2Fx': Timestamp.fromMillis(Date.now() - 60_000) } })
  await expect(getDoc(doc(client('rules-member'), path))).rejects.toMatchObject({ code: 'permission-denied' })
})

test('an environment grant cannot read another environment', async () => {
  await expect(getDoc(doc(client('rules-member'), 'curatorLive/development/batchRevisions/rules-batch'))).rejects.toMatchObject({ code: 'permission-denied' })
})

test.each(['set', 'update', 'delete'])('denies client %s of signals', async operation => {
  const ref = doc(client('rules-member'), path)
  const write = operation === 'set' ? setDoc(ref, { revision: 99 }) : operation === 'update' ? updateDoc(ref, { revision: 99 }) : deleteDoc(ref)
  await expect(write).rejects.toMatchObject({ code: 'permission-denied' })
  expect((await db.doc(path).get()).data()).toEqual({ revision: 7 })
})

test('denies collection listing even with a fresh grant', async () => {
  await expect(getDocs(collection(client('rules-member'), 'curatorLive/preview%3Afeat%2Fx/batchRevisions'))).rejects.toMatchObject({ code: 'permission-denied' })
})

test('denies reading or changing even the signed-in users own grant', async () => {
  const ref = doc(client('rules-member'), 'curatorLiveAccess/rules-member')
  await expect(getDoc(ref)).rejects.toMatchObject({ code: 'permission-denied' })
  await expect(setDoc(ref, { envs: {} })).rejects.toMatchObject({ code: 'permission-denied' })
  await expect(updateDoc(ref, { envs: {} })).rejects.toMatchObject({ code: 'permission-denied' })
  await expect(deleteDoc(ref)).rejects.toMatchObject({ code: 'permission-denied' })
})

test('draft data stays behind the authenticated API', async () => {
  await db.doc('reviewBatches/rules-private').set({ name: 'Private draft' })
  await expect(getDoc(doc(client('rules-member'), 'reviewBatches/rules-private'))).rejects.toMatchObject({ code: 'permission-denied' })
  await db.doc('reviewBatches/rules-private').delete()
})
