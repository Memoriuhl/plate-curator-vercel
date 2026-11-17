import { expect, test, vi } from 'vitest'
import { publishBatch } from '../../lib/publish/publish'
import type { Snapshot } from '../../lib/catalog/types'
import type { PublishDeps, PublishRecord } from '../../lib/publish/types'
import { batch, command, owner, seedOrderStandards } from './fixture'

export type WorkflowOrders = { stateOrder: Record<string, string[]>; stateOrderVersion?: Record<string, number> }
export type OrderFixture = {
  deps: PublishDeps
  workflow(): Promise<WorkflowOrders>
  seedWorkflow(value: WorkflowOrders): Promise<void>
  setLive(snapshot: Snapshot): Promise<void>
  seedReceipt(record: PublishRecord): Promise<void>
}

const cmdA = { ...command, batchId: 'a', commandId: 'cmd-a' }
const cmdB = { ...command, batchId: 'b', commandId: 'cmd-b' }
const ordersA = { CA: ['one', 'two'], NY: ['ny-one', 'ny-two'] }
const ordersB = { CA: ['two', 'one'] }

async function createA(f: OrderFixture) {
  await f.deps.store.create({ ...batch, id: 'a', stateOrders: ordersA })
  await seedOrderStandards(f.deps, 'a')
}

async function publishB(f: OrderFixture, orders: Record<string, string[]> = ordersB) {
  await f.deps.store.create({ ...batch, id: 'b', baselineVersion: 2, stateOrders: orders })
  await seedOrderStandards(f.deps, 'b')
  const result = await publishBatch(f.deps, owner, cmdB)
  if (!result.ok) throw new Error(JSON.stringify(result))
  expect(result).toMatchObject({ ok: true, value: { toVersion: 3, state: 'done' } })
}

async function expectFinishedA(f: OrderFixture) {
  expect(await publishBatch(f.deps, owner, cmdA)).toMatchObject({ ok: true, value: { toVersion: 2, state: 'done' } })
  expect(await f.deps.records.get('a@2')).toMatchObject({ toVersion: 2, state: 'done', committedAt: expect.any(String) })
  expect(await f.deps.store.getBatch('a')).toMatchObject({ state: 'published', revision: 3 })
}

function crashBeforeOrders(f: OrderFixture) {
  const write = f.deps.curator.writeStateOrders
  let failOnce = true
  f.deps.curator.writeStateOrders = async (...args) => {
    if (failOnce && args[1].batchId === 'a') {
      failOnce = false
      throw new Error('crash after pointer commit, before curator bookkeeping')
    }
    return write(...args)
  }
}

export function curatorOrderScenarios(createFixture: () => Promise<OrderFixture>) {
  test.each([
    ['before', 'absent'], ['before', 'versioned'], ['after', 'absent'], ['after', 'versioned'],
  ])('A replay %s B commits preserves shared and independent States with %s prior NY order', async (timing, prior) => {
    const f = await createFixture()
    await f.seedWorkflow({ stateOrder: { TX: ['untouched'], ...(prior === 'versioned' ? { NY: ['ny-two', 'ny-one'] } : {}) }, stateOrderVersion: { TX: 1, ...(prior === 'versioned' ? { NY: 1 } : {}) } })
    await createA(f)
    crashBeforeOrders(f)
    expect(await publishBatch(f.deps, owner, cmdA)).toEqual({ ok: false, error: 'unavailable' })
    expect((await f.deps.pointer.read()).version).toBe(2)
    expect(await f.deps.records.get('a@2')).toMatchObject({ toVersion: 2, committedAt: expect.any(String) })
    if (timing === 'before') await expectFinishedA(f)
    await publishB(f)
    await expectFinishedA(f)
    expect((await f.deps.pointer.read()).version).toBe(3)
    expect(await f.workflow()).toMatchObject({ stateOrder: { ...ordersB, NY: ordersA.NY, TX: ['untouched'] }, stateOrderVersion: { CA: 3, NY: 2, TX: 1 } })
  })

  test('late replay reconciles a legacy shared State while the independent State records its own version', async () => {
    const f = await createFixture()
    await f.seedWorkflow({ stateOrder: {} })
    await createA(f)
    crashBeforeOrders(f)
    expect(await publishBatch(f.deps, owner, cmdA)).toEqual({ ok: false, error: 'unavailable' })
    await publishB(f)
    await f.seedWorkflow({ stateOrder: ordersB })
    await expectFinishedA(f)
    expect((await f.deps.pointer.read()).version).toBe(3)
    expect(await f.workflow()).toEqual({ stateOrder: { ...ordersB, NY: ordersA.NY }, stateOrderVersion: { CA: 3, NY: 2 } })
  })

  test('same-version replay writes idempotently even below a newer pointer that did not touch those States', async () => {
    const f = await createFixture()
    await f.seedWorkflow({ stateOrder: {} })
    await createA(f)
    const commit = f.deps.store.commit
    f.deps.store.commit = vi.fn().mockRejectedValueOnce(new Error('crash before Batch finalization')).mockImplementation(commit)
    const write = vi.spyOn(f.deps.curator, 'writeStateOrders')
    expect(await publishBatch(f.deps, owner, cmdA)).toEqual({ ok: false, error: 'unavailable' })
    const written = await f.workflow()
    expect(written).toEqual({ stateOrder: ordersA, stateOrderVersion: { CA: 2, NY: 2 } })
    await publishB(f, {})
    await expectFinishedA(f)
    expect(write.mock.calls.filter(args => args[1].batchId === 'a')).toHaveLength(2)
    expect(await f.workflow()).toEqual(written)
    expect((await f.deps.pointer.read()).version).toBe(3)
  })

  test.each([false, true])('legacy NY reconciles to the live snapshot when the newer pre-fix Publish touched it: %s', async touched => {
    const f = await createFixture()
    const legacyNY = ['ny-two', 'ny-one']
    await f.seedWorkflow({ stateOrder: { NY: legacyNY } })
    await createA(f)
    crashBeforeOrders(f)
    expect(await publishBatch(f.deps, owner, cmdA)).toEqual({ ok: false, error: 'unavailable' })
    await publishB(f, touched ? { ...ordersB, NY: legacyNY } : ordersB)
    await f.seedWorkflow({ stateOrder: { ...ordersB, NY: legacyNY }, stateOrderVersion: { CA: 3 } })
    await expectFinishedA(f)
    const expectedNY = touched ? legacyNY : ordersA.NY
    expect(await f.workflow()).toEqual({ stateOrder: { ...ordersB, NY: expectedNY }, stateOrderVersion: { CA: 3, NY: 3 } })
    const live = await f.deps.snapshots.read(3)
    expect(live.plates.filter(plate => plate.state === 'NY').sort((a, b) => a.sortOrder! - b.sortOrder!).map(plate => plate.id)).toEqual(expectedNY)
  })

  async function pendingLegacyReplay() {
    const f = await createFixture()
    await f.seedWorkflow({ stateOrder: {} })
    await createA(f)
    crashBeforeOrders(f)
    expect(await publishBatch(f.deps, owner, cmdA)).toEqual({ ok: false, error: 'unavailable' })
    await publishB(f)
    await f.seedWorkflow({ stateOrder: { ...ordersB, NY: ['ny-two', 'ny-one'] }, stateOrderVersion: { CA: 3 } })
    return f
  }

  test('pointer movement during reconciliation reloads and uses the newer snapshot', async () => {
    const f = await pendingLegacyReplay()
    const read = f.deps.snapshots.read
    const reads: number[] = []
    f.deps.snapshots.read = async version => {
      const snapshot = await read(version)
      reads.push(version)
      if (version === 3) await f.setLive({ ...snapshot, version: 4, plates: snapshot.plates.map(plate => plate.state === 'NY' ? { ...plate, sortOrder: plate.id === 'ny-two' ? 0 : 1 } : plate) })
      return snapshot
    }
    await expectFinishedA(f)
    expect(reads).toEqual([3, 4])
    expect(await f.workflow()).toEqual({ stateOrder: { ...ordersB, NY: ['ny-two', 'ny-one'] }, stateOrderVersion: { CA: 3, NY: 4 } })
    expect((await f.deps.pointer.read()).version).toBe(4)
  })

  test('repeated pointer movement exhausts bounded retries without finalizing and can be retried', async () => {
    const f = await pendingLegacyReplay()
    const before = await f.workflow()
    const read = f.deps.snapshots.read
    const reads: number[] = []
    f.deps.snapshots.read = async version => {
      const snapshot = await read(version)
      reads.push(version)
      await f.setLive({ ...snapshot, version: version + 1 })
      return snapshot
    }
    expect(await publishBatch(f.deps, owner, cmdA)).toEqual({ ok: false, error: 'unavailable' })
    expect(reads).toEqual([3, 4, 5])
    expect(await f.workflow()).toEqual(before)
    expect(await f.deps.records.get('a@2')).toMatchObject({ state: 'uploaded', committedAt: expect.any(String) })
    expect(await f.deps.store.getBatch('a')).toMatchObject({ state: 'approved', revision: 2 })
    f.deps.snapshots.read = read
    await expectFinishedA(f)
    expect(await f.workflow()).toMatchObject({ stateOrder: { NY: ordersA.NY }, stateOrderVersion: { NY: 6 } })
  })

  test('the pointer hash is rechecked even when its version stays unchanged', async () => {
    const f = await pendingLegacyReplay()
    const read = f.deps.snapshots.read
    const checksum = f.deps.snapshots.checksum
    let changed = false
    const reads: number[] = []
    f.deps.snapshots.read = async version => { reads.push(version); return read(version) }
    f.deps.snapshots.checksum = async (version, generation) => {
      const hash = await checksum(version, generation)
      if (version === 3 && !changed) {
        changed = true
        const snapshot = await read(version)
        await f.setLive({ ...snapshot, plates: snapshot.plates.map(plate => plate.state === 'NY' ? { ...plate, sortOrder: plate.id === 'ny-two' ? 0 : 1 } : plate) })
      }
      return hash
    }
    await expectFinishedA(f)
    expect(reads).toEqual([3, 3])
    expect(await f.workflow()).toEqual({ stateOrder: { ...ordersB, NY: ['ny-two', 'ny-one'] }, stateOrderVersion: { CA: 3, NY: 3 } })
  })

  test.each(['read failure', 'wrong version', 'checksum mismatch', 'parsed hash mismatch', 'missing pointer hash'])('%s leaves legacy reconciliation retryable', async failure => {
    const f = await pendingLegacyReplay()
    const before = await f.workflow()
    const read = f.deps.snapshots.read
    const checksum = f.deps.snapshots.checksum
    const pointer = f.deps.pointer.read
    if (failure === 'missing pointer hash') f.deps.pointer.read = async () => ({ version: 3 })
    f.deps.snapshots.read = async version => {
      const snapshot = await read(version)
      if (version !== 3) return snapshot
      if (failure === 'read failure') throw new Error('Snapshot read unavailable')
      if (failure === 'wrong version') return { ...snapshot, version: 4 }
      if (failure === 'parsed hash mismatch') return { ...snapshot, plates: snapshot.plates.map(plate => ({ ...plate, sortOrder: 99 })) }
      return snapshot
    }
    if (failure === 'checksum mismatch') f.deps.snapshots.checksum = async (version, generation) => version === 3 ? 'mismatch' : checksum(version, generation)
    expect(await publishBatch(f.deps, owner, cmdA)).toEqual({ ok: false, error: 'unavailable' })
    expect(await f.workflow()).toEqual(before)
    expect(await f.deps.records.get('a@2')).toMatchObject({ state: 'uploaded', committedAt: expect.any(String) })
    expect(await f.deps.store.getBatch('a')).toMatchObject({ state: 'approved', revision: 2 })
    f.deps.snapshots.read = read
    f.deps.snapshots.checksum = checksum
    f.deps.pointer.read = pointer
    await expectFinishedA(f)
    expect(await f.workflow()).toMatchObject({ stateOrder: { NY: ordersA.NY }, stateOrderVersion: { NY: 3 } })
  })

  test('a lost lease during reconciliation prevents State writes and finalization', async () => {
    const f = await pendingLegacyReplay()
    const before = await f.workflow()
    const write = f.deps.curator.writeStateOrders
    f.deps.curator.writeStateOrders = async (...args) => {
      if (args[4]) await f.deps.lock.release(args[1].token, true)
      return write(...args)
    }
    expect(await publishBatch(f.deps, owner, cmdA)).toEqual({ ok: false, error: 'lock_lost' })
    expect(await f.workflow()).toEqual(before)
    expect(await f.deps.records.get('a@2')).toMatchObject({ state: 'uploaded' })
    expect(await f.deps.store.getBatch('a')).toMatchObject({ state: 'approved', revision: 2 })
    f.deps.curator.writeStateOrders = write
    await expectFinishedA(f)
  })

  test('receipt identity is rechecked after the snapshot read before reconciliation writes', async () => {
    const f = await pendingLegacyReplay()
    const before = await f.workflow()
    const receipt = (await f.deps.records.get('a@2'))!
    const read = f.deps.snapshots.read
    f.deps.snapshots.read = async version => {
      const snapshot = await read(version)
      if (version === 3) await f.seedReceipt({ ...receipt, commandId: 'changed' })
      return snapshot
    }
    expect(await publishBatch(f.deps, owner, cmdA)).toEqual({ ok: false, error: 'unavailable' })
    expect(await f.workflow()).toEqual(before)
    expect(await f.deps.records.get('a@2')).toMatchObject({ state: 'uploaded' })
    expect(await f.deps.store.getBatch('a')).toMatchObject({ state: 'approved', revision: 2 })
    f.deps.snapshots.read = read
    await f.seedReceipt(receipt)
    await expectFinishedA(f)
  })

  test.each([false, true])('single Publish atomically records its own version over legacy orders: %s', async legacy => {
    const f = await createFixture()
    await f.seedWorkflow({ stateOrder: legacy ? { CA: ordersB.CA } : {} })
    await createA(f)
    await expectFinishedA(f)
    expect(await f.workflow()).toEqual({ stateOrder: ordersA, stateOrderVersion: { CA: 2, NY: 2 } })
    expect((await f.deps.pointer.read()).version).toBe(2)
  })
}
