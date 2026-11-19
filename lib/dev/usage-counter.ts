import type { Firestore } from '@google-cloud/firestore'

/**
 * Development-only usage counts. They exist to measure how many requests and Firestore
 * operations the app causes over time; nothing reads them in production.
 */
export type UsageCounts = {
  startedAt: number
  updatedAt: number
  projectId: string | null
  firestoreEmulator: boolean
  routes: Record<string, number>
  firestore: {
    documentReads: Record<string, number>
    queries: Record<string, number>
    writes: Record<string, number>
  }
}

const slot = Symbol.for('plate-curator.usage-counts')
const instrumented = Symbol.for('plate-curator.usage-instrumented')

type UsageEnv = {
  USAGE_COUNTER_FILE?: string
  VERCEL_ENV?: string
  NODE_ENV?: string
}

/**
 * Return the counter output file only for local development. Hosted deployments and
 * production builds never count, even if the variable leaks into their environment.
 */
export function usageCounterFile(env: UsageEnv = process.env): string | null {
  if (!env.USAGE_COUNTER_FILE?.trim()) return null
  if (env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview')
    return null
  if (env.NODE_ENV === 'production') return null
  return env.USAGE_COUNTER_FILE.trim()
}

/** Read the process-wide counts, shared by every bundle that loads this module. */
export function usageCounts(): UsageCounts | null {
  return ((globalThis as Record<symbol, unknown>)[slot] as UsageCounts) ?? null
}

/** Create the process-wide counts once; later calls keep the existing totals. */
export function startUsageCounts(now = Date.now()): UsageCounts {
  const existing = usageCounts()
  if (existing) return existing
  const counts: UsageCounts = {
    startedAt: now,
    updatedAt: now,
    projectId: process.env.GCP_PROJECT_ID ?? null,
    firestoreEmulator: Boolean(process.env.FIRESTORE_EMULATOR_HOST),
    routes: {},
    firestore: { documentReads: {}, queries: {}, writes: {} },
  }
  ;(globalThis as Record<symbol, unknown>)[slot] = counts
  return counts
}

/** Add one to a named counter. */
function bump(table: Record<string, number>, key: string, by = 1) {
  table[key] = (table[key] ?? 0) + by
}

/**
 * Count one incoming request by method and path, marking React Server Component
 * navigations. Static assets and development tooling requests are not counted.
 */
export function countRequest(method: string, url: string, rsc = false) {
  const counts = usageCounts()
  if (!counts) return
  const { pathname } = new URL(url, 'http://localhost')
  if (
    pathname.startsWith('/_next/static') ||
    pathname.startsWith('/_next/webpack-hmr') ||
    pathname.startsWith('/__nextjs') ||
    pathname === '/favicon.ico'
  )
    return
  bump(counts.routes, `${method} ${pathname}${rsc ? ' (rsc)' : ''}`)
  counts.updatedAt = Date.now()
}

/**
 * Turn a Firestore document or collection name into its collection pattern, for example
 * `curatorJobs/x/jobs/y` becomes `curatorJobs/*\/jobs`.
 */
export function collectionPattern(name: string): string {
  const relative = name.includes('/documents/')
    ? name.slice(name.indexOf('/documents/') + '/documents/'.length)
    : name.endsWith('/documents')
      ? ''
      : name
  const parts = relative.split('/').filter(Boolean)
  const collections = parts.filter((_, index) => index % 2 === 0)
  return collections.join('/*/') || '(root)'
}

type WriteProto = {
  update?: { name?: string }
  delete?: string
  transform?: { document?: string }
}
type QueryProto = {
  parent?: string
  structuredQuery?: { from?: { collectionId?: string }[] }
  structuredAggregationQuery?: {
    structuredQuery?: { from?: { collectionId?: string }[] }
  }
}

/**
 * Count document reads, queries and committed writes made through one Firestore client.
 * The client's private request helpers are wrapped because every read and commit passes
 * through them, so each operation is counted once.
 */
export function instrumentFirestore(db: Firestore): Firestore {
  const target = db as unknown as Record<string | symbol, unknown>
  if (!usageCounts() || target[instrumented]) return db
  target[instrumented] = true
  const snapshot = target.snapshot_ as (...args: unknown[]) => unknown
  const request = target.request as (...args: unknown[]) => unknown
  const requestStream = target.requestStream as (...args: unknown[]) => unknown
  target.snapshot_ = function (this: unknown, ...args: unknown[]) {
    const counts = usageCounts()
    const value = args[0] as string | { name?: string } | undefined
    const name = typeof value === 'string' ? value : value?.name
    if (counts && name) {
      bump(counts.firestore.documentReads, collectionPattern(name))
      counts.updatedAt = Date.now()
    }
    return snapshot.apply(this, args)
  }
  target.request = function (this: unknown, ...args: unknown[]) {
    const counts = usageCounts()
    const [method, body] = args as [string, { writes?: WriteProto[] }]
    if (counts && (method === 'commit' || method === 'batchWrite')) {
      for (const write of body?.writes ?? []) {
        const name =
          write.update?.name ?? write.delete ?? write.transform?.document
        if (name) bump(counts.firestore.writes, collectionPattern(name))
      }
      counts.updatedAt = Date.now()
    }
    return request.apply(this, args)
  }
  target.requestStream = function (this: unknown, ...args: unknown[]) {
    const counts = usageCounts()
    const [method, , body] = args as [string, unknown, QueryProto]
    if (
      counts &&
      (method === 'runQuery' || method === 'runAggregationQuery') &&
      body
    ) {
      const from =
        body.structuredQuery?.from ??
        body.structuredAggregationQuery?.structuredQuery?.from
      const parent = body.parent ? collectionPattern(body.parent) : '(root)'
      const base = parent === '(root)' ? '' : `${parent}/*/`
      const collection = from?.[0]?.collectionId ?? '?'
      bump(
        counts.firestore.queries,
        `${method === 'runAggregationQuery' ? 'count ' : ''}${base}${collection}`
      )
      counts.updatedAt = Date.now()
    }
    return requestStream.apply(this, args)
  }
  return db
}
