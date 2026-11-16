import type { JurisdictionData } from '@/lib/catalog/dashboard-types'
import { BatchActions } from './batch-actions'

export function StateHeader({
  jurisdiction,
}: {
  jurisdiction: JurisdictionData
}) {
  const plates = jurisdiction.plates
  return (
    <header className="state-header">
      <div>
        <h1 className="page-title">{jurisdiction.name}</h1>
        <p>
          {plates.length} plates ·{' '}
          {
            plates.filter(
              (plate) =>
                plate.templateRole === 'template' || !plate.templateFamily,
            ).length
          }{' '}
          templates ·{' '}
          {plates.filter((plate) => plate.templateRole === 'variant').length}{' '}
          variants · {plates.filter((plate) => plate.complete).length} complete
        </p>
      </div>
      <BatchActions />
    </header>
  )
}
