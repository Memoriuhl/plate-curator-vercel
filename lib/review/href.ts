export function batchHref(path: string, batch: string | null) {
  return batch === null ? path : `${path}?batch=${encodeURIComponent(batch)}`
}

/** Build a review URL that preserves the selected batch and plate when supplied. */
export function reviewHref(state?: string, plate?: string, batch?: string, filters?: { run?: string | null; since?: string | null; scope?: string | null; focusBatch?: string | null }) {
  const query = new URLSearchParams()
  if (state) query.set('state', state)
  if (plate) query.set('plate', plate)
  if (batch) query.set('batch', batch)
  if (filters?.run) query.set('run', filters.run)
  if (filters?.since) query.set('since', filters.since)
  if (filters?.scope) query.set('scope', filters.scope)
  if (filters?.focusBatch) query.set('focusBatch', filters.focusBatch)
  return query.size ? `/review?${query}` : '/review'
}

export function dashboardPlateHref(state: string, plateId: string, batch?: string) {
  const query = new URLSearchParams({ plate: plateId })
  if (batch) query.set('batch', batch)
  return `/states/${encodeURIComponent(state)}?${query}#families`
}
