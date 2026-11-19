import { expect, test, vi } from 'vitest'
import { proposeEdit } from '../../lib/review/batch'
import { approveBatch, submitBatch } from '../helpers/legacy-approval'
import { plateRevision } from '../../lib/review/revision'
import { publishBatch } from '../../lib/publish/publish'
import { validateSnapshot } from '../../lib/publish/validation'
import {
  batch,
  command,
  fixture,
  owner,
  snapshot,
  seedOrderStandards,
} from './fixture'

test('an editor cannot publish', async () => {
  const f = fixture()
  expect(
    await publishBatch(
      f.deps,
      { uid: 'editor', name: null, role: 'editor' },
      command
    )
  ).toEqual({ ok: false, error: 'forbidden' })
  expect(f.records.size).toBe(0)
  expect(f.blobs.has(2)).toBe(false)
})

test('only an approved current revision publishes', async () => {
  for (const state of ['open', 'submitted', 'published', 'conflict'] as const) {
    expect(
      await publishBatch(fixture({ ...batch, state }).deps, owner, command)
    ).toEqual({ ok: false, error: 'invalid_state' })
  }
  expect(
    await publishBatch(fixture().deps, owner, { ...command, revision: 1 })
  ).toEqual({ ok: false, error: 'superseded_revision' })
  expect(
    await publishBatch(fixture().deps, owner, {
      ...command,
      batchId: 'missing',
    })
  ).toEqual({ ok: false, error: 'not_found' })
})

test('an edit after approval supersedes Publish without advancing the catalog', async () => {
  const f = fixture()
  expect(
    await proposeEdit(f.deps, owner, {
      batchId: 'batch',
      plateId: 'one',
      baseRevision: plateRevision(snapshot.plates[0]),
      fields: { tags: ['revised'] },
    })
  ).toMatchObject({
    ok: true,
    value: { batch: { state: 'open', revision: 3, approval: null } },
  })
  expect(await publishBatch(f.deps, owner, command)).toEqual({
    ok: false,
    error: 'superseded_revision',
  })
  expect(f.pointer()).toEqual({ version: 1 })
  expect(f.records.size).toBe(0)
  expect(f.blobs.has(2)).toBe(false)
})

test('builds N+1 from the baseline plus edits', async () => {
  const f = fixture()
  f.deps.store.listEdits = async () => [
    {
      plateId: 'one',
      baseRevision: 'base',
      fields: { tags: ['changed'] },
      authorId: 'editor',
      updatedAt: f.deps.now(),
      resultRevision: 'result',
    },
  ]
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({
    ok: true,
    value: { fromVersion: 1, toVersion: 2, state: 'done' },
  })
  expect(JSON.parse(Buffer.from(f.blobs.get(2)!).toString())).toEqual({
    version: 2,
    plates: [{ ...snapshot.plates[0], tags: ['changed'] }, snapshot.plates[1]],
  })
})

test('refuses a snapshot that drops a plate', () => {
  expect(
    validateSnapshot(snapshot, { version: 2, plates: [snapshot.plates[0]] })
  ).toContain('Missing baseline plate: two')
})

test('story edits retain catalog shapes and clear nullable draft markers in the assembled snapshot', async () => {
  const story = {
    firstIssuedYear: 1976,
    funFacts: [{ text: 'Sourced fact', sourceUrl: 'https://example.org/fact' }],
    readMore: [
      {
        title: 'Reference',
        site: 'Example',
        url: 'https://example.org/reference',
      },
    ],
    wikiUrl: 'https://en.wikipedia.org/wiki/Plate',
  }
  for (const clear of [false, true]) {
    const f = fixture()
    const fields = clear
      ? { firstIssuedYear: null, wikiUrl: null, funFacts: [], readMore: [] }
      : story
    f.deps.store.listEdits = async () => [
      {
        plateId: 'one',
        baseRevision: 'base',
        fields,
        authorId: 'editor',
        updatedAt: f.deps.now(),
        resultRevision: 'result',
      },
    ]
    expect(await publishBatch(f.deps, owner, command)).toMatchObject({
      ok: true,
    })
    const output = JSON.parse(Buffer.from(f.blobs.get(2)!).toString()).plates[0]
    expect(output).toMatchObject(clear ? { funFacts: [], readMore: [] } : story)
    if (clear)
      for (const key of ['firstIssuedYear', 'wikiUrl'])
        expect(output).not.toHaveProperty(key)
  }
})

test('refuses two standard plates in a state', async () => {
  const f = fixture()
  f.deps.snapshots.read = async () => ({
    ...snapshot,
    plates: snapshot.plates.map((plate) => ({ ...plate, isStandard: true })),
  })
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({
    ok: false,
    error: 'invalid_snapshot',
    reasons: ['Multiple standard plates in state: CA'],
  })
  expect(f.blobs.has(2)).toBe(false)
  expect(f.lease()).toBeNull()
})

test('untouched families without a template do not block publish', async () => {
  const f = fixture()
  const baseline = {
    ...snapshot,
    plates: snapshot.plates.map((plate) => ({
      ...plate,
      templateFamily: 'legacy',
      templateRole: 'variant' as const,
    })),
  }
  f.blobs.set(1, Buffer.from(JSON.stringify(baseline)))
  f.deps.store.listEdits = async () => [
    {
      plateId: 'one',
      baseRevision: 'base',
      fields: { tags: ['changed'] },
      authorId: 'editor',
      updatedAt: f.deps.now(),
      resultRevision: 'result',
    },
  ]
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect(
    JSON.parse(Buffer.from(f.blobs.get(2)!).toString()).plates[0]
  ).toMatchObject({
    tags: ['changed'],
    templateFamily: 'legacy',
    templateRole: 'variant',
  })
})

test('a grouping edit cannot give a family two templates', () => {
  const baseline = {
    ...snapshot,
    plates: snapshot.plates.map((plate, index) => ({
      ...plate,
      templateFamily: 'family',
      templateRole: index === 0 ? ('template' as const) : ('variant' as const),
    })),
  }
  const next = {
    version: 2,
    plates: baseline.plates.map((plate) => ({
      ...plate,
      templateRole: 'template' as const,
    })),
  }
  expect(validateSnapshot(baseline, next)).toContain(
    'Family must have at most one template: family'
  )
})

test('a grouping edit cannot remove the only template', () => {
  const baseline = {
    ...snapshot,
    plates: snapshot.plates.map((plate, index) => ({
      ...plate,
      templateFamily: 'old-family',
      templateRole: index === 0 ? ('template' as const) : ('variant' as const),
    })),
  }
  for (const fields of [
    { templateRole: 'variant' as const },
    { templateFamily: 'new-family' },
  ]) {
    const next = {
      version: 2,
      plates: [{ ...baseline.plates[0], ...fields }, baseline.plates[1]],
    }
    expect(validateSnapshot(baseline, next)).toContain(
      'Family must retain exactly one template: old-family'
    )
  }
})

test('a family move validates the destination as well as the old family', () => {
  const baseline = {
    ...snapshot,
    plates: snapshot.plates.map((plate, index) => ({
      ...plate,
      templateFamily: index === 0 ? 'source' : 'destination',
      templateRole: 'template' as const,
    })),
  }
  const next = {
    version: 2,
    plates: [
      { ...baseline.plates[0], templateFamily: 'destination' },
      baseline.plates[1],
    ],
  }
  expect(validateSnapshot(baseline, next)).toContain(
    'Family must have at most one template: destination'
  )
  expect(validateSnapshot(baseline, next)).not.toContain(
    'Family must retain exactly one template: source'
  )
})

test('a variant parent edit touches its family', () => {
  const baseline = {
    ...snapshot,
    plates: snapshot.plates.map((plate) => ({
      ...plate,
      templateFamily: 'family',
      templateRole: 'template' as const,
    })),
  }
  const next = {
    version: 2,
    plates: [
      { ...baseline.plates[0], variantOfPlateId: 'two' },
      baseline.plates[1],
    ],
  }
  expect(validateSnapshot(baseline, next)).toContain(
    'Family must have at most one template: family'
  )
})

test('new template-less families fail while baseline template-less families remain editable', () => {
  const next = {
    version: 2,
    plates: snapshot.plates.map((plate) => ({
      ...plate,
      templateFamily: 'new-family',
      templateRole: 'variant' as const,
    })),
  }
  expect(validateSnapshot(snapshot, next)).toContain(
    'Family must retain exactly one template: new-family'
  )
  const baseline = { ...next, version: 1 }
  expect(
    validateSnapshot(baseline, {
      version: 2,
      plates: [{ ...next.plates[0], variantOfPlateId: 'two' }, next.plates[1]],
    })
  ).toEqual([])
})

test('reordering plates does not touch their grouping', () => {
  const baseline = {
    ...snapshot,
    plates: snapshot.plates.map((plate) => ({
      ...plate,
      templateFamily: 'legacy',
      templateRole: 'variant' as const,
    })),
  }
  expect(
    validateSnapshot(baseline, {
      version: 2,
      plates: [...baseline.plates].reverse(),
    })
  ).toEqual([])
})

test('validates required fields and unique ids', () => {
  for (const key of ['id', 'state', 'slug', 'displayName', 'image', 'tags']) {
    const next = {
      version: 2,
      plates: [{ ...snapshot.plates[0], [key]: null }, snapshot.plates[1]],
    }
    expect(validateSnapshot(snapshot, next).length).toBeGreaterThan(0)
  }
  expect(
    validateSnapshot(snapshot, {
      version: 2,
      plates: [snapshot.plates[0], snapshot.plates[0]],
    })
  ).toContain('Duplicate plate id: one')
  expect(
    validateSnapshot(snapshot, {
      version: 2,
      plates: [{ ...snapshot.plates[0], tags: [1] }, snapshot.plates[1]],
    }).length
  ).toBeGreaterThan(0)
})

test('second publisher waits for the lock', async () => {
  const f = fixture()
  const claim = {
    ...command,
    token: 'other',
    expiresAt: '2026-11-15T12:01:00Z',
  }
  expect(await f.deps.lock.claim(claim, f.deps.now())).toBe(true)
  expect(await publishBatch(f.deps, owner, command)).toEqual({
    ok: false,
    error: 'locked',
  })
  expect(f.blobs.has(2)).toBe(false)
  expect(f.lease()?.token).toBe('other')
})

test('stale lock lease can be taken over', async () => {
  const f = fixture()
  await f.deps.lock.claim(
    { ...command, token: 'old', expiresAt: '2026-11-15T12:00:01Z' },
    f.deps.now()
  )
  f.setTime('2026-11-15T12:00:02Z')
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
})

test('retry after upload-success/pointer-failure reconciles without a new version', async () => {
  const f = fixture()
  const advance = f.deps.pointer.advance
  f.deps.pointer.advance = vi
    .fn()
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockImplementation(advance)
  expect(await publishBatch(f.deps, owner, command)).toEqual({
    ok: false,
    error: 'unavailable',
  })
  expect(f.blobs.has(2)).toBe(true)
  expect(f.pointer().version).toBe(1)
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({
    ok: true,
    value: { toVersion: 2, state: 'done' },
  })
  expect([...f.blobs.keys()]).toEqual([1, 2])
})

test('retry after a committed pointer response is lost reconciles', async () => {
  const f = fixture()
  const advance = f.deps.pointer.advance
  f.deps.pointer.advance = async (...args) => {
    await advance(...args)
    throw new Error('response lost')
  }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({
    ok: false,
    error: 'unavailable',
  })
  expect(f.pointer().version).toBe(2)
  f.deps.pointer.advance = advance
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect([...f.blobs.keys()]).toEqual([1, 2])
})

test('existing object with a different checksum stops with version_taken and releases the lock', async () => {
  const f = fixture()
  f.blobs.set(2, Buffer.from('another release'))
  expect(await publishBatch(f.deps, owner, command)).toEqual({
    ok: false,
    error: 'version_taken',
  })
  expect(f.lease()).toBeNull()
  expect(f.pointer().version).toBe(1)
})

test('pointer moved returns pointer_moved and releases the lock', async () => {
  const f = fixture()
  f.deps.pointer.advance = async () => 'pointer_moved'
  expect(await publishBatch(f.deps, owner, command)).toEqual({
    ok: false,
    error: 'pointer_moved',
  })
  expect(f.lease()).toBeNull()
})

test('success marks record done, batch published, lock released', async () => {
  const f = fixture()
  const result = await publishBatch(f.deps, owner, command)
  expect(result).toMatchObject({
    ok: true,
    value: {
      id: 'batch@2',
      state: 'done',
      blobSha256: await f.deps.snapshots.checksum(2),
    },
  })
  expect(f.records.get('batch@2')?.state).toBe('done')
  expect(await f.deps.store.getBatch('batch')).toMatchObject({
    state: 'published',
    revision: 3,
  })
  expect(f.lease()).toBeNull()
  expect(await publishBatch(f.deps, owner, command)).toEqual(result)
})

test('a lost lease cannot advance the pointer', async () => {
  const f = fixture()
  const upload = f.deps.snapshots.createOnly
  f.deps.snapshots.createOnly = async (...args) => {
    const result = await upload(...args)
    f.setTime('2026-11-15T12:02:00Z')
    await f.deps.lock.claim(
      { ...command, token: 'replacement', expiresAt: '2026-11-15T12:03:00Z' },
      f.deps.now()
    )
    return result
  }
  expect(await publishBatch(f.deps, owner, command)).toEqual({
    ok: false,
    error: 'lock_lost',
  })
  expect(f.pointer().version).toBe(1)
  expect(f.lease()?.token).toBe('replacement')
})

test('batch edits are refused during publication', async () => {
  const f = fixture()
  const upload = f.deps.snapshots.createOnly
  f.deps.snapshots.createOnly = async (...args) => {
    expect(
      await f.deps.store.commit(batch.id, 2, {
        batch: { ...batch, state: 'open', revision: 3 },
      })
    ).toBe('revision_mismatch')
    return upload(...args)
  }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
})

test('retry finishes a published pointer when batch finalization failed', async () => {
  const f = fixture()
  const commit = f.deps.store.commit
  f.deps.store.commit = vi
    .fn()
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockImplementation(commit)
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({
    ok: false,
    error: 'unavailable',
  })
  expect(f.pointer().version).toBe(2)
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
})

test('retry releases a lock when the first final cleanup failed', async () => {
  const f = fixture()
  const release = f.deps.lock.release
  f.deps.lock.release = vi
    .fn()
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockImplementation(release)
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({
    ok: false,
    error: 'unavailable',
  })
  expect(f.lease()).not.toBeNull()
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect(f.lease()).toBeNull()
})

test('malformed baseline data returns invalid_snapshot before upload', async () => {
  for (const plates of [null, [null]]) {
    const f = fixture()
    f.deps.snapshots.read = async () =>
      ({ version: 1, plates }) as unknown as typeof snapshot
    expect(await publishBatch(f.deps, owner, command)).toMatchObject({
      ok: false,
      error: 'invalid_snapshot',
    })
    expect(f.blobs.has(2)).toBe(false)
    expect(f.lease()).toBeNull()
  }
})

test('retry recovers an uploaded object when the upload response was lost', async () => {
  const f = fixture()
  const upload = f.deps.snapshots.createOnly
  const createOnly = vi
    .fn()
    .mockImplementation(async (...args: Parameters<typeof upload>) => {
      await upload(...args)
      throw new Error('response lost')
    })
  f.deps.snapshots.createOnly = createOnly
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({
    ok: false,
    error: 'unavailable',
  })
  expect(f.records.get('batch@2')?.state).toBe('started')
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect(createOnly).toHaveBeenCalledTimes(1)
  expect([...f.blobs.keys()]).toEqual([1, 2])
})

test('the pointer carries the new snapshot download url for the game', async () => {
  const f = fixture()
  const outcome = await publishBatch(f.deps, owner, command)
  expect(outcome.ok).toBe(true)
  expect(f.pointer()).toMatchObject({
    version: 2,
    url: 'https://storage.example/v2.json?token=t2',
  })
})

test.each(['Published description', null])(
  'publishes description edits through the review flow: %j',
  async (description) => {
    const f = fixture({ ...batch, state: 'open', revision: 0, approval: null })
    const result = await proposeEdit(f.deps, owner, {
      batchId: batch.id,
      plateId: 'one',
      baseRevision: plateRevision(snapshot.plates[0]),
      fields: { description },
    })
    expect(result.ok).toBe(true)
    expect(await submitBatch(f.deps, owner, batch.id, 1)).toMatchObject({
      ok: true,
    })
    expect(await approveBatch(f.deps, owner, batch.id, 2)).toMatchObject({
      ok: true,
    })
    expect(
      await publishBatch(f.deps, owner, { ...command, revision: 3 })
    ).toMatchObject({ ok: true })
    expect(
      JSON.parse(Buffer.from(f.blobs.get(2)!).toString()).plates[0]
    ).toMatchObject({ description })
  }
)

test('publishes field edits, state order and an absent cleared variant link together', async () => {
  const f = fixture({ ...batch, stateOrders: { CA: ['two', 'one'] } })
  await seedOrderStandards(f.deps, 'batch')
  f.blobs.set(
    1,
    Buffer.from(
      JSON.stringify({
        ...snapshot,
        plates: [
          { ...snapshot.plates[0], variantOfPlateId: 'two' },
          snapshot.plates[1],
        ],
      })
    )
  )
  const standardEdits = await f.deps.store.listEdits('batch')
  f.deps.store.listEdits = async () => [
    {
      plateId: 'one',
      baseRevision: 'base',
      fields: { tags: ['changed'], variantOfPlateId: null },
      authorId: 'editor',
      updatedAt: f.deps.now(),
      resultRevision: 'result',
    },
    ...standardEdits.filter((edit) => edit.plateId !== 'one'),
  ]
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  const written = JSON.parse(Buffer.from(f.blobs.get(2)!).toString())
  expect(written).toEqual({
    version: 2,
    plates: [
      { ...snapshot.plates[0], tags: ['changed'], sortOrder: 1 },
      {
        ...snapshot.plates[1],
        isStandard: true,
        templateRole: 'template',
        isTemplate: true,
        sortOrder: 0,
      },
    ],
  })
  expect(written.plates[0]).not.toHaveProperty('variantOfPlateId')
  expect(f.stateOrder).toEqual({ NY: ['existing'], CA: ['two', 'one'] })
})

test('publishes a cleared family grouping without its keys or the derived template flag', async () => {
  const f = fixture()
  f.blobs.set(
    1,
    Buffer.from(
      JSON.stringify({
        ...snapshot,
        plates: [
          {
            ...snapshot.plates[0],
            templateFamily: 'family',
            templateRole: 'template',
            isTemplate: true,
          },
          snapshot.plates[1],
        ],
      })
    )
  )
  f.deps.store.listEdits = async () => [
    {
      plateId: 'one',
      baseRevision: 'base',
      // The shared draft's rebase writes null for grouping the old baseline lacked.
      fields: { templateFamily: null, templateRole: null } as never,
      authorId: 'editor',
      updatedAt: f.deps.now(),
      resultRevision: 'result',
    },
  ]
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  const written = JSON.parse(Buffer.from(f.blobs.get(2)!).toString())
  expect(written.plates[0]).toEqual(snapshot.plates[0])
})

test.each([
  ['an image the baseline kept', { imageUrl: 'https://cdn.example.org/one.webp' }],
  ['no image or source', {}],
] as const)(
  'publishes a cleared image and source pair without their keys when the baseline had %s',
  async (_case, media) => {
    const f = fixture()
    const plate = { ...snapshot.plates[0], ...media }
    f.blobs.set(
      1,
      Buffer.from(
        JSON.stringify({ ...snapshot, plates: [plate, snapshot.plates[1]] })
      )
    )
    f.deps.store.listEdits = async () => [
      {
        plateId: 'one',
        baseRevision: 'base',
        // A put-back of a discarded image and source proposal: the old image, or null
        // where the baseline had none, and null for the source the baseline lacked.
        fields: {
          imageUrl: 'imageUrl' in media ? media.imageUrl : null,
          sourceUrl: null,
        },
        authorId: 'editor',
        updatedAt: f.deps.now(),
        resultRevision: 'result',
      },
    ]
    expect(await publishBatch(f.deps, owner, command)).toMatchObject({
      ok: true,
    })
    const written = JSON.parse(Buffer.from(f.blobs.get(2)!).toString())
    expect(written.plates[0]).toEqual(plate)
  }
)

test.each([
  ['missing', ['one']],
  ['extra', ['one', 'two', 'other']],
  ['duplicate', ['one', 'one']],
  ['wrong jurisdiction', ['one', 'other']],
] as const)(
  'rejects a %s plate in a state order before any writes',
  async (_reason, order) => {
    const f = fixture({ ...batch, stateOrders: { CA: [...order] } })
    await seedOrderStandards(f.deps, 'batch')
    expect(await publishBatch(f.deps, owner, command)).toMatchObject({
      ok: false,
      error: 'invalid_snapshot',
      reasons: [expect.stringContaining('CA')],
    })
    expect([...f.blobs.keys()]).toEqual([1])
    expect(f.pointer().version).toBe(1)
    expect(f.stateOrder).toEqual({ NY: ['existing'] })
  }
)

test('curator order is written after the pointer commit and before batch finalization', async () => {
  const f = fixture({ ...batch, stateOrders: { CA: ['two', 'one'] } })
  await seedOrderStandards(f.deps, 'batch')
  const write = f.deps.curator.writeStateOrders
  f.deps.curator.writeStateOrders = async (...args) => {
    expect(f.pointer().version).toBe(2)
    expect(f.records.get('batch@2')?.committedAt).toBeTruthy()
    expect(await f.deps.store.getBatch(batch.id)).toMatchObject({
      state: 'approved',
    })
    return write(...args)
  }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect(f.stateOrder.CA).toEqual(['two', 'one'])
})

test.each([
  'invalid_snapshot',
  'version_taken',
  'pointer_moved',
  'unavailable',
  'lock_lost',
] as const)(
  'does not write curator order when publication fails with %s before commit',
  async (error) => {
    const f = fixture({ ...batch, stateOrders: { CA: ['two', 'one'] } })
    await seedOrderStandards(f.deps, 'batch')
    if (error === 'invalid_snapshot') f.deps.store.listEdits = async () => []
    if (error === 'version_taken')
      f.blobs.set(2, Buffer.from('another release'))
    if (error === 'pointer_moved')
      f.deps.pointer.advance = async () => 'pointer_moved'
    if (error === 'unavailable')
      f.deps.pointer.advance = async () => {
        throw new Error('unavailable')
      }
    if (error === 'lock_lost') f.deps.lock.renew = async () => false
    expect(await publishBatch(f.deps, owner, command)).toMatchObject({
      ok: false,
      error,
    })
    expect(f.stateOrder).toEqual({ NY: ['existing'] })
  }
)

test('lease lost before the curator write leaves the order untouched and can be retried', async () => {
  const f = fixture({ ...batch, stateOrders: { CA: ['two', 'one'] } })
  await seedOrderStandards(f.deps, 'batch')
  const write = f.deps.curator.writeStateOrders
  f.deps.curator.writeStateOrders = async (...args) => {
    f.setTime('2026-11-15T12:02:00Z')
    return write(args[0], args[1], f.deps.now(), args[3])
  }
  expect(await publishBatch(f.deps, owner, command)).toEqual({
    ok: false,
    error: 'lock_lost',
  })
  expect(f.pointer().version).toBe(2)
  expect(f.stateOrder).toEqual({ NY: ['existing'] })
  f.deps.curator.writeStateOrders = write
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect(f.stateOrder.CA).toEqual(['two', 'one'])
  expect([...f.blobs.keys()]).toEqual([1, 2])
})

test.each([
  'started',
  'upload',
  'uploaded',
  'pointer',
  'before curator',
  'curator',
  'done',
  'batch',
  'release',
] as const)(
  'retry after a crash following %s converges on one snapshot and curator order',
  async (step) => {
    const f = fixture({ ...batch, stateOrders: { CA: ['two', 'one'] } })
    await seedOrderStandards(f.deps, 'batch')
    let crashed = false
    /**
     * Simulate an interrupted publish response and mark that the injected failure
     * occurred.
     */
    const crash = () => {
      crashed = true
      throw new Error('response lost')
    }
    const save = f.deps.records.save
    f.deps.records.save = async (...args) => {
      const result = await save(...args)
      if (!crashed && args[0].state === step) crash()
      return result
    }
    const upload = f.deps.snapshots.createOnly
    f.deps.snapshots.createOnly = async (...args) => {
      const result = await upload(...args)
      if (!crashed && step === 'upload') crash()
      return result
    }
    const advance = f.deps.pointer.advance
    f.deps.pointer.advance = async (...args) => {
      const result = await advance(...args)
      if (!crashed && step === 'pointer') crash()
      return result
    }
    const write = f.deps.curator.writeStateOrders
    f.deps.curator.writeStateOrders = async (...args) => {
      if (!crashed && step === 'before curator') crash()
      const result = await write(...args)
      if (!crashed && step === 'curator') crash()
      return result
    }
    const commit = f.deps.store.commit
    f.deps.store.commit = async (...args) => {
      const result = await commit(...args)
      if (!crashed && step === 'batch') crash()
      return result
    }
    const release = f.deps.lock.release
    f.deps.lock.release = async (...args) => {
      if (!crashed && step === 'release') crash()
      return release(...args)
    }
    expect(await publishBatch(f.deps, owner, command)).toEqual({
      ok: false,
      error: 'unavailable',
    })
    const result = await publishBatch(f.deps, owner, command)
    expect(result).toMatchObject({
      ok: true,
      value: { toVersion: 2, state: 'done' },
    })
    expect(await publishBatch(f.deps, owner, command)).toEqual(result)
    expect([...f.blobs.keys()]).toEqual([1, 2])
    expect(f.records.size).toBe(1)
    expect(f.pointer().version).toBe(2)
    expect(f.stateOrder).toEqual({ NY: ['existing'], CA: ['two', 'one'] })
    expect(await f.deps.store.getBatch(batch.id)).toMatchObject({
      state: 'published',
      revision: 3,
    })
  }
)

test.each(['overlapping', 'unrelated'])(
  'fresh Publish refuses an %s intervening release',
  async (kind) => {
    const f = fixture()
    const edits = [
      {
        plateId: 'one',
        baseRevision: plateRevision(snapshot.plates[0]),
        fields: { tags: ['approved proposal'] },
        authorId: 'editor',
        updatedAt: f.deps.now(),
        resultRevision: plateRevision({
          ...snapshot.plates[0],
          tags: ['approved proposal'],
        }),
      },
    ]
    f.deps.store.listEdits = async () => structuredClone(edits)
    f.deps.pointer.read = async () => ({ version: 2 })
    f.blobs.set(
      2,
      Buffer.from(
        JSON.stringify({
          version: 2,
          plates: snapshot.plates.map((plate, i) => ({
            ...plate,
            tags:
              i === (kind === 'overlapping' ? 0 : 1)
                ? ['new live tag']
                : plate.tags,
          })),
        })
      )
    )
    const upload = vi.spyOn(f.deps.snapshots, 'createOnly')
    const advance = vi.spyOn(f.deps.pointer, 'advance')
    expect(await publishBatch(f.deps, owner, command)).toEqual({
      ok: false,
      error: 'stale_baseline',
      reviewedVersion: 1,
      liveVersion: 2,
    })
    expect(upload).not.toHaveBeenCalled()
    expect(advance).not.toHaveBeenCalled()
    expect(f.records.size).toBe(0)
    expect(await f.deps.store.getBatch(batch.id)).toEqual(batch)
    expect(await f.deps.store.listEdits(batch.id)).toEqual(edits)
    expect(f.lease()).toBeNull()
    expect(
      await f.deps.store.commit(batch.id, 2, {
        batch: { ...batch, revision: 3 },
      })
    ).toBe('ok')
  }
)

test('uncommitted legacy receipt from an unreviewed baseline cannot advance', async () => {
  const f = fixture()
  f.records.set('batch@2', {
    id: 'batch@2',
    ...command,
    fromVersion: 2,
    toVersion: 3,
    blobSha256: 'legacy',
    state: 'started',
  })
  const advance = vi.spyOn(f.deps.pointer, 'advance')
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({
    ok: false,
    error: 'receipt_baseline_conflict',
    reviewedVersion: 1,
  })
  expect(advance).not.toHaveBeenCalled()
  expect([...f.blobs.keys()]).toEqual([1])
  expect(f.records.get('batch@2')?.fromVersion).toBe(2)
  expect(f.lease()).toBeNull()
})

test('committed legacy receipt completes bookkeeping despite the old baseline', async () => {
  const f = fixture({ ...batch, baselineVersion: 0 })
  f.blobs.set(2, Buffer.from('committed'))
  f.records.set('batch@2', {
    id: 'batch@2',
    ...command,
    fromVersion: 1,
    toVersion: 2,
    blobSha256: (await f.deps.snapshots.checksum(2))!,
    state: 'uploaded',
    committedAt: f.deps.now(),
  })
  const advance = vi.spyOn(f.deps.pointer, 'advance')
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({
    ok: true,
    value: { toVersion: 2 },
  })
  expect(advance).not.toHaveBeenCalled()
  expect([...f.blobs.keys()]).toEqual([1, 2])
})

test('publish rejects deleting a template while its family retains Variants', async () => {
  const f = fixture()
  const template = {
    ...snapshot.plates[0],
    templateRole: 'template' as const,
    templateFamily: 'family',
  }
  const variant = {
    ...snapshot.plates[1],
    templateRole: 'variant' as const,
    templateFamily: 'family',
    variantOfPlateId: template.id,
  }
  f.blobs.set(
    1,
    Buffer.from(JSON.stringify({ version: 1, plates: [template, variant] }))
  )
  f.deps.store.listEdits = async () => [
    {
      plateId: 'one',
      baseRevision: 'base',
      fields: { deleted: true },
      authorId: 'editor',
      updatedAt: f.deps.now(),
      resultRevision: 'result',
    },
  ]
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({
    ok: false,
    error: 'invalid_snapshot',
    reasons: expect.arrayContaining([
      'Family must retain exactly one template: family',
    ]),
  })
  expect(f.blobs.has(2)).toBe(false)
  expect(f.pointer().version).toBe(1)
  expect(
    validateSnapshot(
      { version: 1, plates: [template, variant] },
      { version: 2, plates: [variant] },
      new Set(['one'])
    )
  ).toContain('Family must retain exactly one template: family')
})

test('publish removes an eligible plate and preserves surviving image references', async () => {
  const f = fixture()
  f.deps.store.listEdits = async () => [
    {
      plateId: 'one',
      baseRevision: 'base',
      fields: { deleted: true },
      authorId: 'editor',
      updatedAt: f.deps.now(),
      resultRevision: 'result',
    },
  ]
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect(JSON.parse(Buffer.from(f.blobs.get(2)!).toString()).plates).toEqual([
    snapshot.plates[1],
  ])
})

test('validation rejects a dangling variant link independently of family changes', () => {
  const next = {
    version: 2,
    plates: snapshot.plates.map((plate) => ({
      ...plate,
      variantOfPlateId: 'missing',
    })),
  }
  expect(validateSnapshot(snapshot, next)).toContain(
    'Missing Variant parent: missing (one)'
  )
})

test.each([true, false])(
  'validation rejects a new draft family without a Template, with explicit link %s',
  (linked) => {
    const next = {
      version: 2,
      plates: [
        {
          ...snapshot.plates[1],
          templateRole: 'variant',
          templateFamily: 'new-family',
          ...(linked ? { variantOfPlateId: 'one' } : {}),
        },
      ],
    }
    expect(validateSnapshot(snapshot, next, new Set(['one']))).toContain(
      'Family must retain exactly one template: new-family'
    )
  }
)

test('moving a member out of a baseline template-less family still validates', () => {
  const baseline = {
    ...snapshot,
    plates: snapshot.plates.map((plate) => ({
      ...plate,
      templateFamily: 'legacy',
      templateRole: 'variant' as const,
    })),
  }
  const next = {
    version: 2,
    plates: [
      {
        ...baseline.plates[0],
        templateFamily: 'solo',
        templateRole: 'template' as const,
      },
      baseline.plates[1],
    ],
  }
  expect(validateSnapshot(baseline, next)).toEqual([])
})
