import type { PlateChecks } from '../catalog/dashboard-types'
import { plateImageUrl } from '../catalog/image-url'
import { plateChecks } from '../catalog/plate-checks'
import type { Plate } from '../catalog/types'

export type RunPlateDetail = {
  id: string
  displayName: string
  state: string
  imageUrl: string | null
  checks: PlateChecks
}

/** Build the plate summary and completeness checks shown in the run details. */
export function runPlateDetail(plate: Plate): RunPlateDetail {
  const imageUrl = plateImageUrl(plate, process.env.PLATE_IMAGE_BASE ?? null)
  return {
    id: plate.id,
    displayName: plate.displayName,
    state: plate.state,
    imageUrl,
    checks: plateChecks(plate, imageUrl),
  }
}
