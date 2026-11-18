import type { PlateCardData, PlateDetail } from '@/lib/catalog/dashboard-types'
import { PLATE_IMAGE_SIZE } from '@/lib/catalog/dashboard-types'
import { isComplete, plateChecks } from '@/lib/catalog/plate-checks'

export type FamilyPlate = Omit<
  PlateCardData,
  'checks' | 'complete' | 'slug' | 'sortOrder' | 'imageSize'
>
export type DetailPlate = Omit<
  PlateDetail['plate'],
  'checks' | 'complete' | 'slug' | 'sortOrder' | 'category'
>
export type PlatePageProps = {
  plate: DetailPlate
  plates: FamilyPlate[]
  stateName: string
  prevId: string | null
  nextId: string | null
  returnQuery?: string
  fromState?: boolean
}

/**
 * Project a plate into the editing record with its revision and current family identity.
 */
export function slimPlate(plate: PlateCardData): FamilyPlate {
  return {
    id: plate.id,
    state: plate.state,
    displayName: plate.displayName,
    imageUrl: plate.imageUrl,
    tags: plate.tags,
    templateFamily: plate.templateFamily,
    templateRole: plate.templateRole,
    variantOfPlateId: plate.variantOfPlateId,
    isStandard: plate.isStandard,
    revision: plate.revision,
  }
}

/**
 * Build a display card from plate detail and derive the completeness indicators it
 * needs.
 */
export function cardData(
  plate: FamilyPlate & {
    description?: string | null
    sourceUrl?: string | null
    wikiUrl?: string | null
  },
): PlateCardData {
  const checks = plateChecks(
    {
      ...plate,
      slug: plate.id.split('.').slice(1).join('.'),
      image: '',
      templateFamily: plate.templateFamily ?? undefined,
      templateRole: plate.templateRole ?? undefined,
      variantOfPlateId: plate.variantOfPlateId ?? undefined,
    },
    plate.imageUrl,
  )
  return {
    ...plate,
    slug: plate.id.split('.').slice(1).join('.'),
    sortOrder: 0,
    imageSize: PLATE_IMAGE_SIZE,
    checks,
    complete: isComplete(checks),
  }
}
