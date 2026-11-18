import { expect, test } from 'vitest'
import {
  confirmQueueRequest,
  enqueueIntent,
  queueRequestId,
} from '../lib/client/queue-intents'

/**
 * Provide isolated in-memory browser storage so request IDs can be tested across
 * simulated reloads.
 */
function storage() {
  const values = new Map<string, string>()
  return {
    /** Read the fixture browser storage through its Storage interface. */ getItem:
      (key: string) => values.get(key) ?? null,
    /** Record a fixture browser storage write for subsequent request recovery. */ setItem:
      (key: string, value: string) => {
        values.set(key, value)
      },
    /** Remove the recorded fixture value when a request is acknowledged. */ removeItem:
      (key: string) => {
        values.delete(key)
      },
  }
}

test('uncertain enqueue survives reload with identical request ID; successful confirmation permits an intentional new run', () => {
  const persisted = storage()
  let sequence = 0
  /**
   * Issue deterministic IDs in allocation order so the test can address each generated
   * record.
   */
  const id = () => `request-${++sequence}`
  const input = {
    batchId: 'batch',
    plateIds: ['AK.one'],
    stages: ['tag' as const],
    previewOnly: true,
  }
  const first = enqueueIntent(persisted, 'editor', input, id)
  expect(
    enqueueIntent(persisted, 'editor', JSON.parse(JSON.stringify(input)), id)
  ).toEqual(first)
  confirmQueueRequest(persisted, 'editor', 'enqueue', 'older-response')
  expect(enqueueIntent(persisted, 'editor', input, id).requestId).toBe(
    first.requestId
  )
  confirmQueueRequest(persisted, 'editor', 'enqueue', first.requestId)
  expect(enqueueIntent(persisted, 'editor', input, id).requestId).not.toBe(
    first.requestId
  )
})

test('retry intents are isolated per account/run and changed options get a new id', () => {
  const persisted = storage()
  let sequence = 0
  /**
   * Issue deterministic IDs in allocation order so the test can address each generated
   * record.
   */
  const id = () => `request-${++sequence}`
  const first = queueRequestId(persisted, 'editor', 'retry:run', {}, id)
  expect(queueRequestId(persisted, 'editor', 'retry:run', {}, id)).toBe(first)
  expect(queueRequestId(persisted, 'other', 'retry:run', {}, id)).not.toBe(
    first
  )
  expect(queueRequestId(persisted, 'editor', 'retry:other', {}, id)).not.toBe(
    first
  )
  expect(
    queueRequestId(persisted, 'editor', 'retry:run', { changed: true }, id)
  ).not.toBe(first)
})

test('uncertain A followed by B then reload retains A identity without eviction', () => {
  const persisted = storage()
  let sequence = 0
  /**
   * Issue deterministic IDs in allocation order so the test can address each generated
   * record.
   */
  const id = () => `request-${++sequence}`
  const input = {
    batchId: 'batch',
    plateIds: ['AK.one'],
    stages: ['tag' as const],
  }
  const a = enqueueIntent(persisted, 'editor', input, id)
  const b = enqueueIntent(
    persisted,
    'editor',
    { ...input, plateIds: ['AK.two'] },
    id
  )
  expect(
    enqueueIntent(persisted, 'editor', JSON.parse(JSON.stringify(input)), id)
  ).toEqual(a)
  confirmQueueRequest(persisted, 'editor', 'enqueue', b.requestId)
  expect(enqueueIntent(persisted, 'editor', input, id)).toEqual(a)
  for (let index = 0; index < 19; index++)
    enqueueIntent(
      persisted,
      'editor',
      { ...input, plateIds: [`AK.${index}`] },
      id
    )
  expect(() =>
    enqueueIntent(persisted, 'editor', { ...input, plateIds: ['AK.full'] }, id)
  ).toThrow('Too many unconfirmed')
  expect(enqueueIntent(persisted, 'editor', input, id)).toEqual(a)
})
