export type FunFact = { text: string; sourceUrl: string; sourceTitle?: string }
export type ReadMoreLink = { title: string; site: string; url: string }
export type StoryFields = {
  funFacts?: FunFact[]
  firstIssuedYear?: number | null
  wikiUrl?: string | null
  readMore?: ReadMoreLink[]
}

export type Plate = StoryFields & {
  sourceUrl?: string | null
  deleted?: boolean
  id: string
  state: string
  slug: string
  displayName: string
  tags: string[]
  image: string
  templateFamily?: string
  templateRole?: 'template' | 'variant'
  variantOfPlateId?: string | null
  isStandard?: boolean
  sortOrder?: number
  description?: string | null
  funFacts?: { text: string; sourceUrl: string; sourceTitle?: string }[]
  readMore?: { title: string; url: string; site?: string }[]
  wikiUrl?: string | null
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
