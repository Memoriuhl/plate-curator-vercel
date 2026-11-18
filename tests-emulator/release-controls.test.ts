import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { publishRun } from '../workflows/approval'
import { firestoreCatalogPushStore } from '../lib/publish/catalog-push'
import { abandonPreparedSnapshot } from '../lib/publish/abandon'
import { firestoreMembersStore } from '../lib/members/firestore-store'
import { copyBatch } from '../lib/review/copy'
import { approveBatch, submitBatch } from '../lib/review/batch'
import { batch, command, owner, snapshot } from '../tests/publish/fixture'
import { actor, cleanupRelease, env, now, releaseFixture, resetRelease } from './release-fixture'
import { db } from './setup'

const context = vi.hoisted(() => ({ publishDeps: vi.fn(), reviewDeps: vi.fn(), catalogPushDeps: vi.fn() }))
vi.mock('../lib/server/context', () => context)
vi.mock('../lib/server/catalog-head', () => ({ catalogChanged: vi.fn() }))
let f: ReturnType<typeof releaseFixture>
/**
 * Run the publish workflow with the recorded authority of the supplied fixture command.
 */
const run = (cmd = command) => publishRun(cmd.batchId, cmd.revision, { ownerUid: cmd.requestedBy.uid, ...cmd })

beforeEach(async () => {
  await resetRelease()
  f = releaseFixture()
  context.publishDeps.mockImplementation(() => f.deps)
  context.reviewDeps.mockImplementation(() => f.deps)
  context.catalogPushDeps.mockImplementation(() => ({ enabled: true, store: firestoreCatalogPushStore(db), send: f.send }))
  await db.doc('users/release-test/devices/one').set({ expoPushToken: 'ExpoPushToken[release-test]' })
})
afterAll(cleanupRelease)

test('#119 stale baseline requires Copy, fresh approval, then exactly one committed push', async () => {
  f.blobs.set(2, Buffer.from(JSON.stringify({ ...snapshot, version: 2 })))
  await db.doc('config/catalog').set({ version: 2 })
  expect(await run()).toMatchObject({ outcome: 'publish_failed', error: 'stale_baseline' })
  expect(f.send).not.toHaveBeenCalled()
  const copied = await copyBatch({ store: f.deps.store, /** Expose the current fixture catalog version so the operation can check its baseline. */ head: async () => 2, snapshot: f.deps.snapshots.read, env, /** Read the controlled test clock so state and lease timestamps advance deterministically. */ now: () => now }, owner, { sourceId: batch.id, sourceRevision: 2, targetVersion: 2 })
  expect(copied.ok).toBe(true)
  if (!copied.ok) throw new Error('Copy failed')
  expect(await submitBatch(f.deps, owner, copied.value.id, 0)).toMatchObject({ ok: true })
  expect(await approveBatch(f.deps, owner, copied.value.id, 1)).toMatchObject({ ok: true })
  const fresh = { ...command, batchId: copied.value.id, commandId: 'copy-command' }
  expect(await run(fresh)).toMatchObject({ outcome: 'published', version: 3 })
  expect(await run(fresh)).toMatchObject({ outcome: 'published', version: 3 })
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(await f.deps.store.getBatch(batch.id)).toMatchObject({ state: 'approved', baselineVersion: 1 })
})

test.each(['before preparation', 'after upload', 'after commit'])('#126 Pause %s: commit ordering controls release and push', async seam => {
  if (seam === 'before preparation') await f.deps.control.change(true, actor, now)
  else {
    const advance = f.deps.pointer.advance
    f.deps.pointer.advance = async (...args) => {
      if (seam === 'after upload') await f.deps.control.change(true, actor, now)
      const result = await advance(...args)
      if (seam === 'after commit') await f.deps.control.change(true, actor, now)
      return result
    }
  }
  expect(await run()).toMatchObject(seam === 'after commit' ? { outcome: 'published', version: 2 } : { outcome: 'publish_failed', error: 'paused' })
  await f.deps.control.change(false, actor, now)
  expect(await run()).toMatchObject(seam === 'after commit' ? { outcome: 'published', version: 2 } : { outcome: 'publish_failed', error: 'paused' })
  expect((await f.deps.pointer.read()).version).toBe(seam === 'after commit' ? 2 : 1)
  expect(f.send).toHaveBeenCalledTimes(seam === 'after commit' ? 1 : 0)
  if (seam === 'before preparation') expect(f.blobs.has(2)).toBe(false)
})

test.each(['before commit', 'after commit', 'revoke then restore'])('#127 requester %s: authority fencing and committed-only push', async seam => {
  const members = firestoreMembersStore(db)
  const advance = f.deps.pointer.advance
  f.deps.pointer.advance = async (...args) => {
    if (seam !== 'after commit') await members.updateRoleGuarded(actor.email, 'editor')
    if (seam === 'revoke then restore') await members.updateRoleGuarded(actor.email, 'owner')
    const result = await advance(...args)
    if (seam === 'after commit') await members.updateRoleGuarded(actor.email, 'editor')
    return result
  }
  expect(await run()).toMatchObject(seam === 'after commit' ? { outcome: 'published', version: 2 } : { outcome: 'publish_failed', error: 'revoked' })
  await members.updateRoleGuarded(actor.email, 'owner')
  expect(await run()).toMatchObject(seam === 'after commit' ? { outcome: 'published', version: 2 } : { outcome: 'publish_failed', error: 'revoked' })
  expect(f.send).toHaveBeenCalledTimes(seam === 'after commit' ? 1 : 0)
})

test('#128 two Owners fresh-click an uploaded stopped receipt: one command, one version, one push', async () => {
  const advance = f.deps.pointer.advance
  f.deps.pointer.advance = async (...args) => { await f.deps.control.change(true, actor, now); return advance(...args) }
  expect(await run()).toMatchObject({ error: 'paused' })
  const bytes = f.blobs.get(2)
  await f.deps.control.change(false, actor, now)
  f.deps.pointer.advance = advance
  const a = { ...command, generation: 3, commandId: 'retry-a' }
  const b = { ...a, commandId: 'retry-b', requestedBy: { ...actor, uid: 'backup', email: 'backup@example.com' } }
  const results = await Promise.all([f.deps.records.accept(a, now), f.deps.records.accept(b, now)])
  expect(results.filter(result => result.ok)).toHaveLength(1)
  const winner = results.find(result => result.ok)!
  if (!winner.ok) throw new Error('No winner')
  expect(await run(winner.command as typeof command)).toMatchObject({ outcome: 'published', version: 2 })
  expect(await run(winner.command as typeof command)).toMatchObject({ outcome: 'published', version: 2 })
  expect(await run()).toMatchObject({ outcome: 'publish_failed' })
  expect(f.blobs.get(2)).toBe(bytes)
  expect(f.send).toHaveBeenCalledTimes(1)
}, 15000)

test('#129 abandon A, publish different B at v3, delayed old work never commits or pushes', async () => {
  const advance = f.deps.pointer.advance
  f.deps.pointer.advance = async (...args) => { await f.deps.control.change(true, actor, now); return advance(...args) }
  expect(await run()).toMatchObject({ error: 'paused' })
  const receipt = (await f.deps.records.get('batch@2'))!
  const object = await f.deps.snapshots.metadata(2)
  expect(await abandonPreparedSnapshot(f.deps, actor, receipt, 'Choose B')).toMatchObject({ ok: true, value: { burnedVersion: 2, object } })
  expect(await f.deps.snapshots.metadata(2)).toEqual(object)
  await db.doc('reviewBatches/other').set({ ...batch, id: 'other', env })
  await db.doc('reviewBatches/other/edits/one').set({ plateId: 'one', baseRevision: 'base', fields: { tags: ['B'] }, authorId: 'owner', updatedAt: now, resultRevision: 'B' })
  await f.deps.control.change(false, actor, now)
  f.deps.pointer.advance = advance
  const other = { ...command, batchId: 'other', commandId: 'other', generation: 3 }
  expect(await run(other)).toMatchObject({ outcome: 'published', version: 3 })
  expect(await run(other)).toMatchObject({ outcome: 'published', version: 3 })
  expect(await run()).toMatchObject({ outcome: 'publish_failed' })
  expect((await f.deps.snapshots.read(3)).version).toBe(3)
  expect((await f.deps.pointer.read()).version).toBe(3)
  expect(f.send).toHaveBeenCalledTimes(1)
  expect((await db.doc('catalogPushes/2').get()).exists).toBe(false)
})

test('global allocator skips burns and legacy held/committed receipts across environments', async () => {
  await db.doc('publishVersionBurns/2').set({ receiptId: 'burned' })
  const legacy = { ...command, fromVersion: 1, blobSha256: 'legacy', env: 'foreign' }
  await db.doc('publishRecords/held').set({ ...legacy, id: 'held', toVersion: 3, state: 'uploaded' })
  await db.doc('publishRecords/committed').set({ ...legacy, id: 'committed', toVersion: 4, state: 'done', committedAt: now, env: 'third-environment' })
  expect(await run()).toMatchObject({ outcome: 'published', version: 5 })
  expect((await f.deps.snapshots.read(5)).version).toBe(5)
  expect(f.send).toHaveBeenCalledTimes(1)
})

test('a global burn blocks adoption and pointer advancement without sending a push', async () => {
  const advance = f.deps.pointer.advance
  f.deps.pointer.advance = async (...args) => { await f.deps.control.change(true, actor, now); return advance(...args) }
  expect(await run()).toMatchObject({ error: 'paused' })
  const stopped = (await f.deps.records.get('batch@2'))!
  await db.doc('publishVersionBurns/2').set({ receiptId: 'foreign-burn', env: 'another-environment' })
  await f.deps.control.change(false, actor, now)
  const fresh = { ...command, commandId: 'burned-adopter', generation: 3 }
  expect(await f.deps.records.accept(fresh, now)).toMatchObject({ ok: true })
  expect(await run(fresh)).toMatchObject({ outcome: 'publish_failed', error: 'version_taken' })
  const lease = { ...fresh, token: 'burn-proof', expiresAt: '2026-11-15T12:01:00Z' }
  expect(await f.deps.lock.claim(lease, now)).toBe(true)
  expect(await advance(stopped, lease, now)).toBe('version_taken')
  await f.deps.lock.release(lease.token, false)
  expect((await f.deps.pointer.read()).version).toBe(1)
  expect(f.send).not.toHaveBeenCalled()
})

test('same-command reservation survives interruption and replay keeps the same toVersion', async () => {
  const upload = f.deps.snapshots.createOnly
  f.deps.snapshots.createOnly = async () => { throw new Error('interrupted before upload') }
  await expect(run()).rejects.toThrow('Publish unavailable')
  expect(await f.deps.records.get('batch@2')).toMatchObject({ toVersion: 2 })
  f.deps.snapshots.createOnly = upload
  expect(await run()).toMatchObject({ outcome: 'published', version: 2 })
  expect(await run()).toMatchObject({ outcome: 'published', version: 2 })
  expect((await db.collection('publishRecords').get()).size).toBe(1)
  expect(f.send).toHaveBeenCalledTimes(1)
})

test('no-burn allocation retains pointer plus one', async () => {
  expect(await run()).toMatchObject({ outcome: 'published', version: 2 })
  expect((await f.deps.pointer.read()).version).toBe(2)
  expect((await db.collection('publishVersionBurns').get()).empty).toBe(true)
})

test('#128 concurrent Publish Workflow runs share one adopted version and one push', async () => {
  const advance = f.deps.pointer.advance
  f.deps.pointer.advance = async (...args) => { await f.deps.control.change(true, actor, now); return advance(...args) }
  expect(await run()).toMatchObject({ error: 'paused' })
  const bytes = f.blobs.get(2)
  await f.deps.control.change(false, actor, now)
  f.deps.pointer.advance = advance
  const fresh = { ...command, commandId: 'concurrent-run', generation: 3 }
  expect(await f.deps.records.accept(fresh, now)).toMatchObject({ ok: true })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const adopt = f.deps.records.adopt
  f.deps.records.adopt = async (...args) => { entered.resolve(); await release.promise; return adopt(...args) }
  const first = run(fresh)
  await entered.promise
  await expect(run(fresh)).rejects.toThrow('Publish locked')
  release.resolve()
  expect(await first).toMatchObject({ outcome: 'published', version: 2 })
  expect(await run(fresh)).toMatchObject({ outcome: 'published', version: 2 })
  expect(f.blobs.get(2)).toBe(bytes)
  expect((await f.deps.pointer.read()).version).toBe(2)
  expect(f.send).toHaveBeenCalledTimes(1)
}, 15000)

test('#129 another Batch skips a stopped held slot without abandon; later disposition is optional', async () => {
  const advance = f.deps.pointer.advance
  f.deps.pointer.advance = async (...args) => { await f.deps.control.change(true, actor, now); return advance(...args) }
  expect(await run()).toMatchObject({ error: 'paused' })
  const stopped = (await f.deps.records.get('batch@2'))!
  await f.deps.control.change(false, actor, now)
  f.deps.pointer.advance = advance
  await db.doc('reviewBatches/other').set({ ...batch, id: 'other', env })
  expect(await run({ ...command, batchId: 'other', commandId: 'other-held', generation: 3 })).toMatchObject({ outcome: 'published', version: 3 })
  expect((await db.collection('publishVersionBurns').get()).empty).toBe(true)
  expect(await abandonPreparedSnapshot(f.deps, actor, stopped, 'Disposition only')).toMatchObject({ ok: true })
  expect((await f.deps.pointer.read()).version).toBe(3)
  expect(f.send).toHaveBeenCalledTimes(1)
})
