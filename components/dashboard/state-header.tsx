import type { JurisdictionData } from '@/lib/catalog/dashboard-types'
import { BatchActions } from './batch-actions'

export function StateHeader({
  jurisdiction,
}: {
  jurisdiction: JurisdictionData
}) {
  const plates = jurisdiction.plates
  const local = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
  function runPlate({ id, state, displayName, revision, tags, checks, wikiUrl, funFacts, firstIssuedYear, readMore }: typeof plates[number]) {
    return { id, state, displayName, revision, tags, ...(local ? {
      description: checks.description.value, wikiUrl, funFacts, firstIssuedYear, readMore, hasStory: checks.funFacts.status === 'good',
    } : {}) }
  }
  return (
    <BatchActions
      stateCode={jurisdiction.code}
      stateName={jurisdiction.name}
      allPlates={local ? plates.map(runPlate) : undefined}
      underTagged={plates.filter(plate => plate.checks.tags.status !== 'good').map(runPlate)}
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
