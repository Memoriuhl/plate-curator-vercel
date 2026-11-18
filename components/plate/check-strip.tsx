import { PLATE_CHECK_KEYS, type PlateChecks } from '@/lib/catalog/dashboard-types'
import { StatusIcon } from './status-icon'

/** Show the configured completeness checks together for a plate row. */
export function CheckStrip({ checks }: { checks: PlateChecks }) {
  return <div role="group" aria-label="Plate checks" data-check-strip className="inline-flex flex-nowrap items-center">{PLATE_CHECK_KEYS.map(checkKey => <StatusIcon key={checkKey} checkKey={checkKey} check={checks[checkKey]} />)}</div>
}
