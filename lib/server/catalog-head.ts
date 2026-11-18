import 'server-only'
import { cacheLife, cacheTag, revalidateTag } from 'next/cache'
import { catalog } from './context'

export const CATALOG_HEAD_TAG = 'catalog-head'

/**
 * Share the live version and curator state in Next.js's remote cache so state switches
 * can skip the Firestore reads.
 */
export async function cachedCatalogHead() {
  'use cache: remote'
  cacheTag(CATALOG_HEAD_TAG)
  // Periodic revalidation also picks up changes made outside the tagged writes.
  cacheLife({ stale: 60, revalidate: 300, expire: 3600 })
  const source = catalog()
  const [version, curator] = await Promise.all([
    source.readVersion(),
    source.readCuratorState(),
  ])
  return { version, curator }
}

/** Expire the remote head after publish or curator writes so the next server read reloads it. */
export function catalogChanged() {
  try {
    revalidateTag(CATALOG_HEAD_TAG, { expire: 0 })
  } catch (error) {
    console.error('[catalog] could not clear the cached catalog head', error)
  }
}
