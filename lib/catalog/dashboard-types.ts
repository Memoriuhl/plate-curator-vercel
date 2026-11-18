import type { StateProgress, StoryFields } from './types'

export type CheckStatus = 'good' | 'weak' | 'missing'

export type Check = { status: CheckStatus; value: string | null }

export const PLATE_CHECK_KEYS = ['description', 'funFacts', 'link', 'tags', 'family', 'image', 'rarity'] as const

export type PlateCheckKey = (typeof PLATE_CHECK_KEYS)[number]

export type PlateChecks = Record<PlateCheckKey, Check>

export const COMPLETENESS_CHECK_KEYS = ['description', 'link', 'tags', 'family', 'image'] as const satisfies readonly PlateCheckKey[]

export const PLATE_IMAGE_SIZE = { width: 320, height: 160 } as const

export type ImageSize = { width: number; height: number }

export type JurisdictionSummary = {
  code: string
  name: string
  region: string
  plateCount: number
  completeCount: number
  progress: StateProgress | null
}

export type PlateCardData = StoryFields & {
  colorDetail?: string | null
  lineageColor?: string | null
  deleted?: boolean
  pipelineBatchId?: string
  id: string
  state: string
  slug: string
  displayName: string
  imageUrl: string | null
  imageSize: ImageSize
  tags: string[]
  templateFamily: string | null
  templateRole: 'template' | 'variant' | null
  variantOfPlateId: string | null
  isStandard: boolean
  sortOrder: number
  revision: string
  checks: PlateChecks
  complete: boolean
}

export type DashboardData = { catalogVersion: number; jurisdictions: JurisdictionSummary[] }

export type JurisdictionData = { catalogVersion: number; code: string; name: string; region: string; plates: PlateCardData[] }

export type PlateDetail = {
  plate: PlateCardData & StoryFields & {
    description: string | null
    category: string | null
    sourceUrl: string | null
    wikiUrl: string | null
  }
  family: PlateCardData[]
  prevId: string | null
  nextId: string | null
}
