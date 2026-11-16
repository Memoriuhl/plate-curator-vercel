import type { Snapshot } from '../catalog/types'
import { sha256 } from './bytes'
import type { PublishSnapshots } from './types'

export function gcsSnapshots(bucket: string, accessToken: () => Promise<string>, fetcher: typeof fetch = fetch): PublishSnapshots {
  const encodedBucket = encodeURIComponent(bucket)
  const download = async (version: number) => {
    const object = encodeURIComponent(`catalog/v${version}.json`)
    return fetcher(`https://storage.googleapis.com/storage/v1/b/${encodedBucket}/o/${object}?alt=media`, {
      headers: { Authorization: `Bearer ${await accessToken()}` }, cache: 'no-store',
    })
  }
  return {
    async read(version) {
      const response = await download(version)
      if (!response.ok) throw new Error(`Snapshot read failed: ${response.status}`)
      return await response.json() as Snapshot
    },
    async createOnly(version, bytes) {
      const query = new URLSearchParams({ uploadType: 'media', name: `catalog/v${version}.json`, ifGenerationMatch: '0' })
      const response = await fetcher(`https://storage.googleapis.com/upload/storage/v1/b/${encodedBucket}/o?${query}`, {
        method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: new Uint8Array(bytes),
      })
      if (response.status === 412) return 'exists'
      if (!response.ok) throw new Error(`Snapshot upload failed: ${response.status}`)
      return 'created'
    },
    async checksum(version) {
      const response = await download(version)
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`Snapshot checksum failed: ${response.status}`)
      return sha256(new Uint8Array(await response.arrayBuffer()))
    },
  }
}
