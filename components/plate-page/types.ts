import type { PlateCardData, PlateDetail } from '@/lib/catalog/dashboard-types'

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
  templateIndex: number
  templateCount: number
  returnQuery?: string
  fromState?: boolean
}

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
