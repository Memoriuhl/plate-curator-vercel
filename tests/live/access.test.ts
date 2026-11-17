import { expect, test } from 'vitest'
import { grantLiveAccess } from '../../lib/live/access'
import { liveEnvKey, signalPath } from '../../lib/review/live-signal'

test('grants one hour of access to the encoded review environment', async () => {
  const grants: unknown[] = []
  const result = await grantLiveAccess({
    env: 'preview:feat/x', now: () => new Date('2026-11-16T12:00:00.000Z'),
    write: async (...args) => { grants.push(args) },
  }, 'member')
  expect(result).toEqual({ envKey: 'preview%3Afeat%2Fx', expiresAt: '2026-11-16T13:00:00.000Z' })
  expect(grants).toEqual([['member', 'preview%3Afeat%2Fx', new Date('2026-11-16T13:00:00.000Z')]])
  expect(liveEnvKey('development')).toBe('development')
  expect(signalPath(result.envKey, 'batch')).toBe('curatorLive/preview%3Afeat%2Fx/batchRevisions/batch')
})

test('a failed grant write cannot report access', async () => {
  await expect(grantLiveAccess({ env: 'development', now: () => new Date(), write: async () => { throw new Error('unavailable') } }, 'member')).rejects.toThrow('unavailable')
})
