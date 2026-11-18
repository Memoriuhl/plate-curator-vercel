import type { JurisdictionData } from '@/lib/catalog/dashboard-types'
import { BatchActions } from './batch-actions'

/** Show state completeness counts alongside the batch actions for its plates. */
export function StateHeader({
  jurisdiction,
}: {
  jurisdiction: JurisdictionData
}) {
  const plates = jurisdiction.plates
  const local = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
  function runPlate({
    id,
    state,
    displayName,
    revision,
    tags,
    checks,
    wikiUrl,
    funFacts,
    firstIssuedYear,
    readMore,
  }: (typeof plates)[number]) {
    return {
      id,
      state,
      displayName,
      revision,
      tags,
      ...(local
        ? {
            description: checks.description.value,
            wikiUrl,
            funFacts,
            firstIssuedYear,
            readMore,
            hasStory: checks.funFacts.status === 'good',
          }
        : {}),
    }
  }
  return (
    <BatchActions
      stateCode={jurisdiction.code}
      stateName={jurisdiction.name}
      allPlates={local ? plates.map(runPlate) : undefined}
      underTagged={plates
        .filter((plate) => plate.checks.tags.status !== 'good')
        .map(runPlate)}
    >
      <div>
        <h1 className="page-title">{jurisdiction.name}</h1>
        <ul
          aria-label="Plate counts"
          className="flex list-none flex-wrap gap-x-5 gap-y-1 text-[var(--ink-2)]"
        >
          <li>{plates.length} plates</li>
          <li>
            {
              plates.filter(
                (plate) =>
                  plate.templateRole === 'template' || !plate.templateFamily
              ).length
            }{' '}
            templates
          </li>
          <li>
            {plates.filter((plate) => plate.templateRole === 'variant').length}{' '}
            variants
          </li>
          <li>{plates.filter((plate) => plate.complete).length} complete</li>
        </ul>
      </div>
    </BatchActions>
  )
}
