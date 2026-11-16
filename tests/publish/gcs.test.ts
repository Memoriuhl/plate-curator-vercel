import { createHash } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { gcsSnapshots } from '../../lib/publish/gcs-snapshots'
import { snapshot } from './fixture'

test('uploads with a create-only generation precondition and exact bytes', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
  const snapshots = gcsSnapshots('demo-bucket', async () => 'test-token', fetcher)
  const bytes = Buffer.from(JSON.stringify(snapshot))
  expect(await snapshots.createOnly(2, bytes)).toBe('created')
  const [input, init] = fetcher.mock.calls[0]
  const url = new URL(String(input))
  expect(url.origin + url.pathname).toBe('https://storage.googleapis.com/upload/storage/v1/b/demo-bucket/o')
  expect(url.searchParams.get('uploadType')).toBe('media')
  expect(url.searchParams.get('name')).toBe('catalog/v2.json')
  expect(url.searchParams.get('ifGenerationMatch')).toBe('0')
  expect(init?.method).toBe('POST')
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token')
  expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
  expect(Buffer.from(init?.body as Uint8Array)).toEqual(bytes)
})

test('a precondition failure means the object already exists', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 412 }))
  expect(await gcsSnapshots('demo-bucket', async () => 'test-token', fetcher).createOnly(2, new Uint8Array())).toBe('exists')
})

test('reads snapshots and hashes the actual object bytes', async () => {
  const body = JSON.stringify(snapshot)
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(body))
  const snapshots = gcsSnapshots('demo-bucket', async () => 'test-token', fetcher)
  expect(await snapshots.read(1)).toEqual(snapshot)
  expect(await snapshots.checksum(1)).toBe(createHash('sha256').update(body).digest('hex'))
  expect(String(fetcher.mock.calls[0][0])).toContain('catalog%2Fv1.json?alt=media')
  expect(fetcher.mock.calls[0][1]?.cache).toBe('no-store')
})

test('a missing checksum is distinct from an unavailable object', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValue(new Response(null, { status: 503 }))
  const snapshots = gcsSnapshots('demo-bucket', async () => 'test-token', fetcher)
  expect(await snapshots.checksum(2)).toBeNull()
  await expect(snapshots.checksum(2)).rejects.toThrow('503')
  await expect(snapshots.createOnly(2, new Uint8Array())).rejects.toThrow('503')
  await expect(snapshots.read(2)).rejects.toThrow('503')
})
