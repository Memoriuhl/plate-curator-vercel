import { expect, test, vi } from 'vitest'
import { publishBatch } from '../../lib/publish/publish'
import { validateSnapshot } from '../../lib/publish/validation'
import { batch, command, fixture, owner, snapshot } from './fixture'

test('an editor cannot publish', async () => {
  const f = fixture()
  expect(await publishBatch(f.deps, { uid: 'editor', role: 'editor' }, command)).toEqual({ ok: false, error: 'forbidden' })
  expect(f.records.size).toBe(0)
  expect(f.blobs.has(2)).toBe(false)
})

test('only an approved current revision publishes', async () => {
  for (const state of ['open', 'submitted', 'published', 'conflict'] as const) {
    expect(await publishBatch(fixture({ ...batch, state }).deps, owner, command)).toEqual({ ok: false, error: 'invalid_state' })
  }
  expect(await publishBatch(fixture().deps, owner, { ...command, revision: 1 })).toEqual({ ok: false, error: 'superseded_revision' })
  expect(await publishBatch(fixture().deps, owner, { ...command, batchId: 'missing' })).toEqual({ ok: false, error: 'not_found' })
})

test('builds N+1 from the baseline plus edits', async () => {
  const f = fixture()
  f.deps.store.listEdits = async () => [{ plateId: 'one', baseRevision: 'base', fields: { tags: ['changed'] }, authorId: 'editor', updatedAt: f.deps.now(), resultRevision: 'result' }]
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true, value: { fromVersion: 1, toVersion: 2, state: 'done' } })
  expect(JSON.parse(Buffer.from(f.blobs.get(2)!).toString())).toEqual({ version: 2, plates: [{ ...snapshot.plates[0], tags: ['changed'] }, snapshot.plates[1]] })
})

test('refuses a snapshot that drops a plate', () => {
  expect(validateSnapshot(snapshot, { version: 2, plates: [snapshot.plates[0]] })).toContain('Missing baseline plate: two')
})

test('refuses two standard plates in a state', async () => {
  const f = fixture()
  f.deps.snapshots.read = async () => ({ ...snapshot, plates: snapshot.plates.map(plate => ({ ...plate, isStandard: true })) })
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: false, error: 'invalid_snapshot', reasons: ['Multiple standard plates in state: CA'] })
  expect(f.blobs.has(2)).toBe(false)
  expect(f.lease()).toBeNull()
})

test('untouched families without a template do not block publish', async () => {
  const f = fixture()
  const baseline = { ...snapshot, plates: snapshot.plates.map(plate => ({ ...plate, templateFamily: 'legacy', templateRole: 'variant' as const })) }
  f.blobs.set(1, Buffer.from(JSON.stringify(baseline)))
  f.deps.store.listEdits = async () => [{ plateId: 'one', baseRevision: 'base', fields: { tags: ['changed'] }, authorId: 'editor', updatedAt: f.deps.now(), resultRevision: 'result' }]
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect(JSON.parse(Buffer.from(f.blobs.get(2)!).toString()).plates[0]).toMatchObject({ tags: ['changed'], templateFamily: 'legacy', templateRole: 'variant' })
})

test('a grouping edit cannot give a family two templates', () => {
  const baseline = { ...snapshot, plates: snapshot.plates.map((plate, index) => ({ ...plate, templateFamily: 'family', templateRole: index === 0 ? 'template' as const : 'variant' as const })) }
  const next = { version: 2, plates: baseline.plates.map(plate => ({ ...plate, templateRole: 'template' as const })) }
  expect(validateSnapshot(baseline, next)).toContain('Family must have at most one template: family')
})

test('a grouping edit cannot remove the only template', () => {
  const baseline = { ...snapshot, plates: snapshot.plates.map((plate, index) => ({ ...plate, templateFamily: 'old-family', templateRole: index === 0 ? 'template' as const : 'variant' as const })) }
  for (const fields of [{ templateRole: 'variant' as const }, { templateFamily: 'new-family' }]) {
    const next = { version: 2, plates: [{ ...baseline.plates[0], ...fields }, baseline.plates[1]] }
    expect(validateSnapshot(baseline, next)).toContain('Family must retain exactly one template: old-family')
  }
})

test('a family move validates the destination as well as the old family', () => {
  const baseline = { ...snapshot, plates: snapshot.plates.map((plate, index) => ({ ...plate, templateFamily: index === 0 ? 'source' : 'destination', templateRole: 'template' as const })) }
  const next = { version: 2, plates: [{ ...baseline.plates[0], templateFamily: 'destination' }, baseline.plates[1]] }
  expect(validateSnapshot(baseline, next)).toContain('Family must have at most one template: destination')
  expect(validateSnapshot(baseline, next)).toContain('Family must retain exactly one template: source')
})

test('a variant parent edit touches its family', () => {
  const baseline = { ...snapshot, plates: snapshot.plates.map(plate => ({ ...plate, templateFamily: 'family', templateRole: 'template' as const })) }
  const next = { version: 2, plates: [{ ...baseline.plates[0], variantOfPlateId: 'two' }, baseline.plates[1]] }
  expect(validateSnapshot(baseline, next)).toContain('Family must have at most one template: family')
})

test('grouping edits may leave a family without templates when it had none', () => {
  const next = { version: 2, plates: snapshot.plates.map(plate => ({ ...plate, templateFamily: 'new-family', templateRole: 'variant' as const })) }
  expect(validateSnapshot(snapshot, next)).toEqual([])
  const baseline = { ...next, version: 1 }
  expect(validateSnapshot(baseline, { version: 2, plates: [{ ...next.plates[0], variantOfPlateId: 'two' }, next.plates[1]] })).toEqual([])
})

test('reordering plates does not touch their grouping', () => {
  const baseline = { ...snapshot, plates: snapshot.plates.map(plate => ({ ...plate, templateFamily: 'legacy', templateRole: 'variant' as const })) }
  expect(validateSnapshot(baseline, { version: 2, plates: [...baseline.plates].reverse() })).toEqual([])
})

test('validates required fields and unique ids', () => {
  for (const key of ['id', 'state', 'slug', 'displayName', 'image', 'tags']) {
    const next = { version: 2, plates: [{ ...snapshot.plates[0], [key]: null }, snapshot.plates[1]] }
    expect(validateSnapshot(snapshot, next).length).toBeGreaterThan(0)
  }
  expect(validateSnapshot(snapshot, { version: 2, plates: [snapshot.plates[0], snapshot.plates[0]] })).toContain('Duplicate plate id: one')
  expect(validateSnapshot(snapshot, { version: 2, plates: [{ ...snapshot.plates[0], tags: [1] }, snapshot.plates[1]] }).length).toBeGreaterThan(0)
})

test('second publisher waits for the lock', async () => {
  const f = fixture()
  const claim = { ...command, token: 'other', expiresAt: '2026-11-15T12:01:00Z' }
  expect(await f.deps.lock.claim(claim, f.deps.now())).toBe(true)
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: 'locked' })
  expect(f.blobs.has(2)).toBe(false)
  expect(f.lease()?.token).toBe('other')
})

test('stale lock lease can be taken over', async () => {
  const f = fixture()
  await f.deps.lock.claim({ ...command, token: 'old', expiresAt: '2026-11-15T12:00:01Z' }, f.deps.now())
  f.setTime('2026-11-15T12:00:02Z')
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
})

test('retry after upload-success/pointer-failure reconciles without a new version', async () => {
  const f = fixture()
  const advance = f.deps.pointer.advance
  f.deps.pointer.advance = vi.fn().mockRejectedValueOnce(new Error('temporary failure')).mockImplementation(advance)
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: 'unavailable' })
  expect(f.blobs.has(2)).toBe(true)
  expect(f.pointer().version).toBe(1)
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true, value: { toVersion: 2, state: 'done' } })
  expect([...f.blobs.keys()]).toEqual([1, 2])
})

test('retry after a committed pointer response is lost reconciles', async () => {
  const f = fixture()
  const advance = f.deps.pointer.advance
  f.deps.pointer.advance = async (...args) => { await advance(...args); throw new Error('response lost') }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: false, error: 'unavailable' })
  expect(f.pointer().version).toBe(2)
  f.deps.pointer.advance = advance
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect([...f.blobs.keys()]).toEqual([1, 2])
})

test('existing object with a different checksum stops with version_taken and releases the lock', async () => {
  const f = fixture()
  f.blobs.set(2, Buffer.from('another release'))
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: 'version_taken' })
  expect(f.lease()).toBeNull()
  expect(f.pointer().version).toBe(1)
})

test('pointer moved returns pointer_moved and releases the lock', async () => {
  const f = fixture()
  f.deps.pointer.advance = async () => 'pointer_moved'
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: 'pointer_moved' })
  expect(f.lease()).toBeNull()
})

test('success marks record done, batch published, lock released', async () => {
  const f = fixture()
  const result = await publishBatch(f.deps, owner, command)
  expect(result).toMatchObject({ ok: true, value: { id: 'batch@2', state: 'done', blobSha256: await f.deps.snapshots.checksum(2) } })
  expect(f.records.get('batch@2')?.state).toBe('done')
  expect(await f.deps.store.getBatch('batch')).toMatchObject({ state: 'published', revision: 3 })
  expect(f.lease()).toBeNull()
  expect(await publishBatch(f.deps, owner, command)).toEqual(result)
})

test('a lost lease cannot advance the pointer', async () => {
  const f = fixture()
  const upload = f.deps.snapshots.createOnly
  f.deps.snapshots.createOnly = async (...args) => {
    const result = await upload(...args)
    f.setTime('2026-11-15T12:02:00Z')
    await f.deps.lock.claim({ ...command, token: 'replacement', expiresAt: '2026-11-15T12:03:00Z' }, f.deps.now())
    return result
  }
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: 'lock_lost' })
  expect(f.pointer().version).toBe(1)
  expect(f.lease()?.token).toBe('replacement')
})

test('batch edits are refused during publication', async () => {
  const f = fixture()
  const upload = f.deps.snapshots.createOnly
  f.deps.snapshots.createOnly = async (...args) => {
    expect(await f.deps.store.commit(batch.id, 2, { batch: { ...batch, state: 'open', revision: 3 } })).toBe('revision_mismatch')
    return upload(...args)
  }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
})

test('retry finishes a published pointer when batch finalization failed', async () => {
  const f = fixture()
  const commit = f.deps.store.commit
  f.deps.store.commit = vi.fn().mockRejectedValueOnce(new Error('temporary failure')).mockImplementation(commit)
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: false, error: 'unavailable' })
  expect(f.pointer().version).toBe(2)
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
})

test('retry releases a lock when the first final cleanup failed', async () => {
  const f = fixture()
  const release = f.deps.lock.release
  f.deps.lock.release = vi.fn().mockRejectedValueOnce(new Error('temporary failure')).mockImplementation(release)
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: false, error: 'unavailable' })
  expect(f.lease()).not.toBeNull()
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect(f.lease()).toBeNull()
})

test('malformed baseline data returns invalid_snapshot before upload', async () => {
  for (const plates of [null, [null]]) {
    const f = fixture()
    f.deps.snapshots.read = async () => ({ version: 1, plates }) as unknown as typeof snapshot
    expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: false, error: 'invalid_snapshot' })
    expect(f.blobs.has(2)).toBe(false)
    expect(f.lease()).toBeNull()
  }
})

test('retry recovers an uploaded object when the upload response was lost', async () => {
  const f = fixture()
  const upload = f.deps.snapshots.createOnly
  const createOnly = vi.fn().mockImplementation(async (...args: Parameters<typeof upload>) => {
    await upload(...args)
    throw new Error('response lost')
  })
  f.deps.snapshots.createOnly = createOnly
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: false, error: 'unavailable' })
  expect(f.records.get('batch@2')?.state).toBe('started')
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect(createOnly).toHaveBeenCalledTimes(1)
  expect([...f.blobs.keys()]).toEqual([1, 2])
})
