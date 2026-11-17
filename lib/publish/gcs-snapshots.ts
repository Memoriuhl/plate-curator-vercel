import type { Snapshot } from '../catalog/types'
import { sha256 } from './bytes'
import type { PublishSnapshots } from './types'

const objectName = (version: number) => `catalog/v${version}.json`

export function gcsSnapshots(bucket: string, accessToken: () => Promise<string>, fetcher: typeof fetch = fetch): PublishSnapshots {
  const encodedBucket = encodeURIComponent(bucket)
  const download = async (version: number, generation?: string) => {
    const object = encodeURIComponent(`catalog/v${version}.json`)
    const query = new URLSearchParams({ alt: 'media', ...(generation ? { generation } : {}) })
    return fetcher(`https://storage.googleapis.com/storage/v1/b/${encodedBucket}/o/${object}?${query}`, {
      headers: { Authorization: `Bearer ${await accessToken()}` }, cache: 'no-store',
    })
  }
  return {
    async metadata(version) {
      const object = encodeURIComponent(objectName(version))
      const response = await fetcher(`https://storage.googleapis.com/storage/v1/b/${encodedBucket}/o/${object}?fields=generation,metageneration,md5Hash,crc32c,metadata`, {
        headers: { Authorization: `Bearer ${await accessToken()}` }, cache: 'no-store',
      })
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`Snapshot metadata failed: ${response.status}`)
      const body = await response.json() as { generation?: string; metageneration?: string; md5Hash?: string; crc32c?: string; metadata?: { firebaseStorageDownloadTokens?: string } }
      const token = body.metadata?.firebaseStorageDownloadTokens?.split(',')[0]
      if (!token || typeof body.generation !== 'string' || !/^\d+$/.test(body.generation) || typeof body.metageneration !== 'string' || !/^\d+$/.test(body.metageneration) || !(body.md5Hash || body.crc32c)) return null
      return { generation: body.generation, metageneration: body.metageneration, ...(body.md5Hash ? { md5Hash: body.md5Hash } : {}), ...(body.crc32c ? { crc32c: body.crc32c } : {}), url: `https://firebasestorage.googleapis.com/v0/b/${encodedBucket}/o/${object}?alt=media&token=${token}` }
    },
    async read(version) {
      const response = await download(version)
      if (!response.ok) throw new Error(`Snapshot read failed: ${response.status}`)
      return await response.json() as Snapshot
    },
    async createOnly(version, bytes) {
      const boundary = `snapshot-${crypto.randomUUID()}`
      const metadata = { name: objectName(version), contentType: 'application/json', metadata: { firebaseStorageDownloadTokens: crypto.randomUUID() } }
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
        Buffer.from(bytes),
        Buffer.from(`\r\n--${boundary}--`),
      ])
      const query = new URLSearchParams({ uploadType: 'multipart', ifGenerationMatch: '0' })
      const response = await fetcher(`https://storage.googleapis.com/upload/storage/v1/b/${encodedBucket}/o?${query}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: new Uint8Array(body),
      })
      if (response.status === 412) return 'exists'
      if (!response.ok) throw new Error(`Snapshot upload failed: ${response.status}`)
      return 'created'
    },
    async downloadUrl(version) {
      const object = encodeURIComponent(objectName(version))
      const response = await fetcher(`https://storage.googleapis.com/storage/v1/b/${encodedBucket}/o/${object}?fields=metadata`, {
        headers: { Authorization: `Bearer ${await accessToken()}` }, cache: 'no-store',
      })
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`Snapshot metadata failed: ${response.status}`)
      const body = await response.json() as { metadata?: { firebaseStorageDownloadTokens?: string } }
      const token = body.metadata?.firebaseStorageDownloadTokens?.split(',')[0]
      return token ? `https://firebasestorage.googleapis.com/v0/b/${encodedBucket}/o/${object}?alt=media&token=${token}` : null
    },
    async checksum(version, generation) {
      const response = await download(version, generation)
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`Snapshot checksum failed: ${response.status}`)
      return sha256(new Uint8Array(await response.arrayBuffer()))
    },
  }
}
