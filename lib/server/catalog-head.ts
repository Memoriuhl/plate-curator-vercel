import 'server-only'
import { cacheLife, cacheTag, revalidateTag } from 'next/cache'
import { catalog } from './context'

export const CATALOG_HEAD_TAG = 'catalog-head'

export async function cachedCatalogHead() {
  'use cache: remote'
  cacheTag(CATALOG_HEAD_TAG)
  cacheLife({ stale: 60, revalidate: 300, expire: 3600 })
  const source = catalog()
  const [version, curator] = await Promise.all([source.readVersion(), source.readCuratorState()])
  return { version, curator }
}

export function catalogChanged() {
  try {
    revalidateTag(CATALOG_HEAD_TAG, { expire: 0 })
  } catch (error) {
    console.error('[catalog] could not clear the cached catalog head', error)
  }
}
