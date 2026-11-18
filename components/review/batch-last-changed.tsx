import type { ReviewBatch } from '@/lib/review/types'

const formatDate = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
})

export function BatchLastChanged({ batch }: { batch: ReviewBatch }) {
  const at = batch.lastChangedAt ?? (batch.revision === 0 ? batch.createdAt : undefined)
  if (!at || !Number.isFinite(Date.parse(at))) return <span>Last change unavailable</span>

  return <time dateTime={at}>{batch.lastChangedAt ? 'Last changed' : 'Created'} {formatDate.format(new Date(at))} UTC</time>
}
