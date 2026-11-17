import { expect, test } from 'vitest'
import { publishBaselineStatus } from '../../lib/publish/baseline-status'
import { publishBatch } from '../../lib/publish/publish'
import { batch, command, fixture, owner } from './fixture'

test('a failed pointer_moved receipt exposes stale recovery when the live head exceeds the reviewed baseline', async () => {
  const f = fixture()
  f.records.set('batch@2', { id: 'batch@2', ...command, fromVersion: 1, toVersion: 2, blobSha256: 'old', state: 'failed', failure: 'pointer_moved' })
  f.deps.pointer.read = async () => ({ version: 2 })
  expect(await publishBaselineStatus(f.deps, batch)).toEqual({ error: 'stale_baseline', reviewedVersion: 1, liveVersion: 2 })
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: 'stale_baseline', reviewedVersion: 1, liveVersion: 2 })
  expect([...f.blobs.keys()]).toEqual([1])
  expect(f.lease()).toBeNull()
})
