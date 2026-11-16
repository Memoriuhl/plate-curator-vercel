'use client'

import * as hooks from '@/lib/client/hooks'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import type { EditableFields, ReviewError } from '@/lib/review/types'

export type EditPlate = Pick<
  PlateCardData,
  | 'id'
  | 'state'
  | 'displayName'
  | 'tags'
  | 'templateFamily'
  | 'templateRole'
  | 'variantOfPlateId'
  | 'isStandard'
  | 'revision'
> & { description?: string | null }
export type EditResult =
  | { ok: true }
  | {
      ok: false
      error: ReviewError | 'unavailable'
      current?: EditPlate
      draft?: EditableFields
    }
type EditHooks = {
  useEditPlate(): {
    edit(plate: EditPlate, fields: EditableFields): Promise<EditResult>
    pending: boolean
  }
  useDraftOverlay<T extends EditPlate>(
    plates: T[],
  ): (T & { changedInBatch: boolean })[]
}

const available = hooks as unknown as Partial<EditHooks>

function useUnavailableEdit() {
  return {
    pending: false,
    edit: async (): Promise<EditResult> => ({
      ok: false,
      error: 'unavailable',
    }),
  }
}

function useBaseline<T extends EditPlate>(plates: T[]) {
  return plates.map((plate) => ({ ...plate, changedInBatch: false }))
}

export const useEditPlate = available.useEditPlate ?? useUnavailableEdit
export const useDraftOverlay = available.useDraftOverlay ?? useBaseline
