import { catalogPushDeps } from '../lib/server/context'
import { sendCatalogPush, type CatalogPushResult } from '../lib/publish/catalog-push'

/**
 * Deliver post-publish notifications in a durable step without turning a notification
 * failure into a failed release.
 */
export async function catalogPush(version: number): Promise<CatalogPushResult> {
  'use step'
  try {
    return await sendCatalogPush(catalogPushDeps(), version)
  } catch {
    return { status: 'unavailable', sent: 0, failed: 0, pruned: 0 }
  }
}
