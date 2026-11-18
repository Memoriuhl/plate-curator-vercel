import { createHash } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { gcsSnapshots } from '../../lib/publish/gcs-snapshots'
import { snapshot } from './fixture'

test('uploads create-only, with a Firebase download token, and the exact bytes', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
  const snapshots = gcsSnapshots(
    'demo-bucket',
    async () => 'test-token',
    fetcher
  )
  const bytes = Buffer.from(JSON.stringify(snapshot))
  expect(await snapshots.createOnly(2, bytes)).toBe('created')
  const [input, init] = fetcher.mock.calls[0]
  const url = new URL(String(input))
  expect(url.origin + url.pathname).toBe(
    'https://storage.googleapis.com/upload/storage/v1/b/demo-bucket/o'
  )
  expect(url.searchParams.get('uploadType')).toBe('multipart')
  expect(url.searchParams.get('ifGenerationMatch')).toBe('0')
  expect(init?.method).toBe('POST')
  expect(new Headers(init?.headers).get('authorization')).toBe(
    'Bearer test-token'
  )
  const contentType = new Headers(init?.headers).get('content-type') ?? ''
  expect(contentType).toMatch(/^multipart\/related; boundary=/)
  const body = Buffer.from(init?.body as Uint8Array).toString()
  const metadata = JSON.parse(body.split('\r\n\r\n')[1].split('\r\n--')[0])
  expect(metadata).toMatchObject({
    name: 'catalog/v2.json',
    contentType: 'application/json',
  })
  expect(metadata.metadata.firebaseStorageDownloadTokens).toMatch(
    /^[0-9a-f-]{36}$/
  )
  expect(body).toContain(bytes.toString())
})

test('downloadUrl builds the Firebase download URL from the object token', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        metadata: { firebaseStorageDownloadTokens: 'tok-1,tok-2' },
      })
    )
  )
  const snapshots = gcsSnapshots(
    'demo-bucket',
    async () => 'test-token',
    fetcher
  )
  expect(await snapshots.downloadUrl(2)).toBe(
    'https://firebasestorage.googleapis.com/v0/b/demo-bucket/o/catalog%2Fv2.json?alt=media&token=tok-1'
  )
  expect(String(fetcher.mock.calls[0][0])).toBe(
    'https://storage.googleapis.com/storage/v1/b/demo-bucket/o/catalog%2Fv2.json?fields=metadata'
  )
})

test('one metadata response binds the download token to its generation and object hashes', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        generation: '123',
        metageneration: '4',
        md5Hash: 'md5',
        crc32c: 'crc',
        metadata: { firebaseStorageDownloadTokens: 'current-token' },
      })
    )
  )
  const snapshots = gcsSnapshots('demo-bucket', async () => 'token', fetcher)
  expect(await snapshots.metadata(2)).toEqual({
    generation: '123',
    metageneration: '4',
    md5Hash: 'md5',
    crc32c: 'crc',
    url: 'https://firebasestorage.googleapis.com/v0/b/demo-bucket/o/catalog%2Fv2.json?alt=media&token=current-token',
  })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(String(fetcher.mock.calls[0][0])).toContain(
    'fields=generation,metageneration,md5Hash,crc32c,metadata'
  )
})

test('checksum verification selects the exact object generation', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('generation bytes'))
  const snapshots = gcsSnapshots('demo-bucket', async () => 'token', fetcher)
  await snapshots.checksum(2, '123')
  expect(
    new URL(String(fetcher.mock.calls[0][0])).searchParams.get('generation')
  ).toBe('123')
})

test('downloadUrl is null for a missing object or one without a token', async () => {
  const missing = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 404 }))
  expect(
    await gcsSnapshots('demo-bucket', async () => 't', missing).downloadUrl(2)
  ).toBeNull()
  const tokenless = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({})))
  expect(
    await gcsSnapshots('demo-bucket', async () => 't', tokenless).downloadUrl(2)
  ).toBeNull()
})

test('a precondition failure means the object already exists', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 412 }))
  expect(
    await gcsSnapshots(
      'demo-bucket',
      async () => 'test-token',
      fetcher
    ).createOnly(2, new Uint8Array())
  ).toBe('exists')
})

test('reads snapshots and hashes the actual object bytes', async () => {
  const body = JSON.stringify(snapshot)
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(body))
  const snapshots = gcsSnapshots(
    'demo-bucket',
    async () => 'test-token',
    fetcher
  )
  expect(await snapshots.read(1)).toEqual(snapshot)
  expect(await snapshots.checksum(1)).toBe(
    createHash('sha256').update(body).digest('hex')
  )
  expect(String(fetcher.mock.calls[0][0])).toContain(
    'catalog%2Fv1.json?alt=media'
  )
  expect(fetcher.mock.calls[0][1]?.cache).toBe('no-store')
})

test('a missing checksum is distinct from an unavailable object', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValue(new Response(null, { status: 503 }))
  const snapshots = gcsSnapshots(
    'demo-bucket',
    async () => 'test-token',
    fetcher
  )
  expect(await snapshots.checksum(2)).toBeNull()
  await expect(snapshots.checksum(2)).rejects.toThrow('503')
  await expect(snapshots.createOnly(2, new Uint8Array())).rejects.toThrow('503')
  await expect(snapshots.read(2)).rejects.toThrow('503')
})
