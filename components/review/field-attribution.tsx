import type { PipelineFieldChange } from '@/lib/review/types'

const formatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
})

export function FieldAttribution({ change }: { change: PipelineFieldChange }) {
  return (
    <span className="caption">
      Pipeline · {change.byName || change.by}
      {Number.isFinite(Date.parse(change.at)) && (
        <>
          {' '}
          ·{' '}
          <time dateTime={change.at}>
            {formatter.format(new Date(change.at))} UTC
          </time>
        </>
      )}
    </span>
  )
}
