import catalog from './catalog-demo.json'
import {
  COMPLETENESS_CHECK_KEYS,
  type PlateCardData,
  type PlateChecks,
} from '@/lib/catalog/dashboard-types'

const ids = [
  'AK.standard_gold',
  'AK.army',
  'AK.air_force',
  'AK.alaska_national_guard',
  'AK.coast_guard',
  'AK.marines',
  'AK.navy',
  'CO.court_appointed_special_advocates_for_children_c_a_s_a_motorcycle',
]
const images: Record<string, string> = {
  'AK.standard_gold': '/plates/ak_standard_gold.webp',
  'AK.army': '/plates/ak_army.webp',
  'AK.air_force': '/plates/ak_air_force.webp',
  'AK.navy': '/plates/ak_navy.webp',
}

export const plateCards: PlateCardData[] = ids.map((id, index) => {
  const plate = catalog.plates.find((plate) => plate.id === id)!
  const imageUrl = images[id] ?? null
  const checks: PlateChecks = {
    description: {
      status: plate.description ? 'good' : 'missing',
      value: plate.description ?? null,
    },
    funFacts: { status: 'missing', value: null },
    link: {
      status: plate.sourceUrl ? 'good' : 'missing',
      value: plate.sourceUrl ?? null,
    },
    tags: {
      status: index === 2 ? 'weak' : plate.tags.length ? 'good' : 'missing',
      value: plate.tags.length ? plate.tags.join(', ') : null,
    },
    family: { status: 'good', value: plate.templateFamily ?? plate.id },
    image: { status: imageUrl ? 'good' : 'missing', value: imageUrl },
    rarity: { status: 'missing', value: null },
  }
  return {
    id: plate.id,
    state: plate.state,
    slug: plate.slug,
    displayName: plate.displayName,
    imageUrl,
    imageSize: { width: 72, height: 36 },
    tags: plate.tags,
    templateFamily:
      index === 0 || index === 7 ? plate.id : (plate.templateFamily ?? null),
    templateRole:
      index === 0 || index === 1 || index === 7 ? 'template' : 'variant',
    variantOfPlateId: index > 1 && index < 7 ? 'AK.army' : null,
    isStandard: plate.isStandard ?? false,
    sortOrder: plate.sortOrder,
    revision: 'fixture-1',
    checks,
    complete: COMPLETENESS_CHECK_KEYS.every(
      (key) => checks[key].status === 'good'
    ),
  }
})
