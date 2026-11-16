import { PLATE_CHECK_KEYS, type PlateChecks } from '@/lib/catalog/dashboard-types'
import { StatusIcon } from './status-icon'

export function CheckStrip({ checks }: { checks: PlateChecks }) {
  return <div role="group" aria-label="Plate checks" className="inline-flex flex-wrap items-center">{PLATE_CHECK_KEYS.map(checkKey => <StatusIcon key={checkKey} checkKey={checkKey} check={checks[checkKey]} />)}</div>
}
