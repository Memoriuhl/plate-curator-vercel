export type CatalogSourceKind = 'firestore' | 'fixture'

/**
 * Select the configured catalog source and prevent fixture mode where live data is
 * required.
 */
export function catalogSourceKind(env: { CATALOG_SOURCE?: string; VERCEL_ENV?: string }): CatalogSourceKind {
  const requested = env.CATALOG_SOURCE ?? 'firestore'
  if (requested === 'firestore') return 'firestore'
  if (requested !== 'fixture') throw new Error(`Unknown CATALOG_SOURCE "${requested}"`)
  if (env.VERCEL_ENV === 'preview' || env.VERCEL_ENV === 'production') {
    throw new Error(`CATALOG_SOURCE=fixture is refused on ${env.VERCEL_ENV}`)
  }
  return 'fixture'
}
