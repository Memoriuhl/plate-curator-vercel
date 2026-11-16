import 'server-only'
import { cacheLife } from 'next/cache'
import type { Snapshot } from '../catalog/types'
import { loadSnapshot } from '../gcp/storage'

export async function cachedSnapshot(version: number): Promise<Snapshot> {
  'use cache: remote'
  cacheLife('max')
  return loadSnapshot(version)
}
