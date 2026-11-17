import { expect, test } from 'vitest'
import { publishBatch } from '../../lib/publish/publish'
import { batch, command, fixture, owner, seedOrderStandards } from './fixture'

test('replay of a committed-but-unfinished Publish must not overwrite a newer Batch curator State order', async () => {
  const a = { ...batch, id: 'a', stateOrders: { CA: ['one', 'two'] } }
  const f = fixture(a)
  await seedOrderStandards(f.deps, 'a')
  const write = f.deps.curator.writeStateOrders
  let failOnce = true
  f.deps.curator.writeStateOrders = async (...args) => {
    if (failOnce && args[1].batchId === 'a') { failOnce = false; throw new Error('crash after pointer commit, before curator bookkeeping') }
    return write(...args)
  }
  const cmdA = { ...command, batchId: 'a', commandId: 'cmd-a' }
  expect(await publishBatch(f.deps, owner, cmdA)).toEqual({ ok: false, error: 'unavailable' })
  expect(f.pointer().version).toBe(2)
  const b = { ...batch, id: 'b', baselineVersion: 2, stateOrders: { CA: ['two', 'one'] } }
  await f.deps.store.create(b as never)
  await seedOrderStandards(f.deps, 'b')
  expect(await publishBatch(f.deps, owner, { ...command, batchId: 'b', commandId: 'cmd-b' })).toMatchObject({ ok: true, value: { toVersion: 3 } })
  expect(f.stateOrder.CA).toEqual(['two', 'one'])
  expect(await publishBatch(f.deps, owner, cmdA)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect(f.pointer().version).toBe(3)
  expect(f.stateOrder.CA).toEqual(['two', 'one'])
})
