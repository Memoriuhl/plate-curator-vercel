import type { JurisdictionData } from '@/lib/catalog/dashboard-types'
import { BatchActions } from './batch-actions'

export function StateHeader({
  jurisdiction,
}: {
  jurisdiction: JurisdictionData
}) {
  const plates = jurisdiction.plates
  return (
    <BatchActions
      stateCode={jurisdiction.code}
      stateName={jurisdiction.name}
      allPlates={process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' ? plates.map(({ id, state, displayName, revision, tags, checks }) => ({ id, state, displayName, revision, tags, hasStory: checks.funFacts.status === 'good' })) : undefined}
      underTagged={plates
        .filter((plate) => plate.checks.tags.status !== 'good')
        .map(({ id, state, displayName, revision, tags, checks }) => ({
          id,
          state,
          displayName,
          revision,
          tags,
          ...(process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' ? { hasStory: checks.funFacts.status === 'good' } : {}),
        }))}
    >
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
    </BatchActions>
  )
}
