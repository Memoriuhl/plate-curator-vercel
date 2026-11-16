export type Plate = {
  id: string
  state: string
  slug: string
  displayName: string
  tags: string[]
  image: string
  templateFamily?: string
  templateRole?: 'template' | 'variant'
  variantOfPlateId?: string
  isStandard?: boolean
  sortOrder?: number
  description?: string | null
  [key: string]: unknown
}

export type Snapshot = { version: number; plates: Plate[] }

export type StateProgress = 'in_progress' | 'needs_ordering' | 'done'

export type CuratorState = {
  stateOrder: Record<string, string[]>
  stateProgress: Record<string, StateProgress>
}

export interface CatalogSource {
  readVersion(): Promise<number>
  readSnapshot(): Promise<Snapshot>
  readCuratorState(): Promise<CuratorState>
  imageUrl(plate: Plate): string | null
}
