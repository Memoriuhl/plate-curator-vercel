import { expect, test, vi } from 'vitest'
import { expoPushSender, sendCatalogPush, type CatalogPushDeps, type PushTicket } from '../../lib/publish/catalog-push'

function fixture(count = 1) {
  let claimed = false
  const store = {
    claim: vi.fn(async () => { if (claimed) return false; claimed = true; return true }),
    devices: vi.fn(async () => Array.from({ length: count }, (_, i) => ({ path: `users/u/devices/${i}`, token: `ExpoPushToken[${i}]` }))),
    prune: vi.fn(async () => true),
    finish: vi.fn(async () => {}),
  }
  const send = vi.fn(async (messages: { to: string }[]): Promise<PushTicket[]> => messages.map(() => ({ status: 'ok' as const })))
  const deps: CatalogPushDeps = { enabled: true, store, send }
  return { deps, store, send }
}

test('claims a version once, including concurrent retries', async () => {
  const f = fixture()
  await Promise.all([sendCatalogPush(f.deps, 8), sendCatalogPush(f.deps, 8)])
  expect(f.send).toHaveBeenCalledExactlyOnceWith([{ to: 'ExpoPushToken[0]', title: 'New plates are available', data: { type: 'catalog', version: 8 } }])
  expect(f.store.finish).toHaveBeenCalledWith(8, expect.objectContaining({ sent: 1, failed: 0 }))
})

test('disabled does not read or claim anything', async () => {
  const f = fixture()
  expect(await sendCatalogPush({ ...f.deps, enabled: false }, 8)).toMatchObject({ status: 'disabled' })
  expect(f.store.claim).not.toHaveBeenCalled()
})

test('batches by 100 and prunes unregistered devices', async () => {
  const f = fixture(201)
  f.send.mockImplementation(async messages => messages.map(() => ({ status: 'error', details: { error: 'DeviceNotRegistered' } })))
  expect(await sendCatalogPush(f.deps, 8)).toMatchObject({ sent: 0, failed: 201, pruned: 201 })
  expect(f.send.mock.calls.map(([messages]) => messages.length)).toEqual([100, 100, 1])
  expect(f.store.prune).toHaveBeenCalledTimes(201)
})

test('ambiguous send failures are recorded and never resent', async () => {
  const f = fixture()
  f.send.mockRejectedValue(new Error('timeout'))
  expect(await sendCatalogPush(f.deps, 8)).toMatchObject({ status: 'completed', failed: 1 })
  await sendCatalogPush(f.deps, 8)
  expect(f.send).toHaveBeenCalledOnce()
})

test('storage failures remain best effort', async () => {
  const f = fixture()
  f.store.claim.mockRejectedValue(new Error('offline'))
  expect(await sendCatalogPush(f.deps, 8)).toMatchObject({ status: 'unavailable' })
  expect(f.store.finish).not.toHaveBeenCalled()
})

test('HTTP sender authenticates and validates Expo responses', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ status: 'ok', id: 'ticket' }] }))
  const messages = [{ to: 'ExpoPushToken[test]', title: 'New plates are available', data: { type: 'catalog' as const, version: 8 } }]
  await expect(expoPushSender('secret', request)(messages)).resolves.toMatchObject([{ status: 'ok' }])
  expect(request).toHaveBeenCalledWith('https://exp.host/--/api/v2/push/send', expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: JSON.stringify(messages) }))
  for (const response of [new Response('', { status: 503 }), Response.json({ data: [] }), Response.json({ errors: [{}] })]) {
    request.mockResolvedValueOnce(response)
    await expect(expoPushSender('secret', request)(messages)).rejects.toThrow()
  }
})
