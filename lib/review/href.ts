export function batchHref(path: string, batch: string | null) {
  return batch === null ? path : `${path}?batch=${encodeURIComponent(batch)}`
}

export function reviewHref(state?: string, plate?: string, batch?: string, filters?: { run?: string | null; since?: string | null; scope?: string | null }) {
  const query = new URLSearchParams()
  if (state) query.set('state', state)
  if (plate) query.set('plate', plate)
  if (batch) query.set('batch', batch)
  if (filters?.run) query.set('run', filters.run)
  if (filters?.since) query.set('since', filters.since)
  if (filters?.scope) query.set('scope', filters.scope)
  return query.size ? `/review?${query}` : '/review'
}
