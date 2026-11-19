type ClientUsage = {
  listens: Record<string, number>
  snapshots: Record<string, number>
}

/**
 * Count live listener starts and snapshots in development measurements. Firestore bills
 * each listener snapshot as a document read. Off unless NEXT_PUBLIC_USAGE_COUNTER is 1.
 */
export function countClientUsage(kind: 'listen' | 'snapshot', key: string) {
  if (
    process.env.NEXT_PUBLIC_USAGE_COUNTER !== '1' ||
    typeof window === 'undefined'
  )
    return
  const scope = window as unknown as { __curatorUsage?: ClientUsage }
  const usage = (scope.__curatorUsage ??= { listens: {}, snapshots: {} })
  const table = kind === 'listen' ? usage.listens : usage.snapshots
  table[key] = (table[key] ?? 0) + 1
}
