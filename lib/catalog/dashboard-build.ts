import { familyRole } from './families'
import { plateRevision } from '../review/revision'
import { PLATE_IMAGE_SIZE } from './dashboard-types'
import type { DashboardData, JurisdictionData, PlateCardData, PlateDetail } from './dashboard-types'
import { isComplete, plateChecks } from './plate-checks'
import { JURISDICTIONS } from './jurisdictions'
import { orderedStatePlates } from './order'
import type { CatalogSource, CuratorState, Plate, Snapshot } from './types'

type ImageUrl = CatalogSource['imageUrl']

const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null

export function plateCard(plate: Plate, index: number, imageUrl: ImageUrl): PlateCardData {
  const url = imageUrl(plate)
  const family = text(plate.templateFamily)
  const role = familyRole(plate)
  const checks = plateChecks(plate, url)
  return {
    id: plate.id, state: plate.state, slug: plate.slug, displayName: plate.displayName,
    imageUrl: url, imageSize: PLATE_IMAGE_SIZE, tags: plate.tags,
    templateFamily: family, templateRole: role, variantOfPlateId: plate.variantOfPlateId ?? null,
    isStandard: plate.isStandard ?? false, sortOrder: plate.sortOrder ?? index,
    revision: plateRevision(plate), checks,
    ...(process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' ? { funFacts: plate.funFacts ?? [], readMore: plate.readMore ?? [], wikiUrl: plate.wikiUrl ?? null, firstIssuedYear: plate.firstIssuedYear ?? null, colorDetail: plate.colorDetail ?? null, lineageColor: plate.lineageColor ?? null } : {}),
    complete: isComplete(checks),
  }
}

function jurisdiction(code: string) {
  return { code, name: JURISDICTIONS[code] ?? code, region: Object.hasOwn(JURISDICTIONS, code) ? 'US' : 'other' }
}

export function buildDashboard(snapshot: Snapshot, curator: CuratorState, imageUrl: ImageUrl): DashboardData {
  const jurisdictions = [...new Set(snapshot.plates.map(plate => plate.state))].map(code => {
    const plates = orderedStatePlates(snapshot, code, curator).map((plate, index) => plateCard(plate, index, imageUrl))
    return {
      ...jurisdiction(code), plateCount: plates.length,
      completeCount: plates.filter(plate => plate.complete).length,
      progress: curator.stateProgress[code] ?? null,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
  return { catalogVersion: snapshot.version, jurisdictions }
}

export function buildJurisdiction(snapshot: Snapshot, curator: CuratorState, imageUrl: ImageUrl, code: string): JurisdictionData | null {
  const plates = orderedStatePlates(snapshot, code, curator)
  if (plates.length === 0) return null
  return { ...jurisdiction(code), catalogVersion: snapshot.version, plates: plates.map((plate, index) => plateCard(plate, index, imageUrl)) }
}

export function buildPlate(snapshot: Snapshot, curator: CuratorState, imageUrl: ImageUrl, id: string): PlateDetail | null {
  const plate = snapshot.plates.find(plate => plate.id === id)
  if (!plate) return null
  const plates = orderedStatePlates(snapshot, plate.state, curator)
  const index = plates.findIndex(plate => plate.id === id)
  return {
    plate: {
      ...plateCard(plate, index, imageUrl),
      description: plate.description ?? null, category: text(plate.category),
      sourceUrl: text(plate.sourceUrl), wikiUrl: text(plate.wikiUrl),
      funFacts: Array.isArray(plate.funFacts) ? plate.funFacts : [],
      readMore: Array.isArray(plate.readMore) ? plate.readMore : [],
      ...(process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' ? { firstIssuedYear: plate.firstIssuedYear ?? null } : {}),
    },
    family: plate.templateFamily ? plates.flatMap((member, memberIndex) =>
      member.templateFamily === plate.templateFamily ? [plateCard(member, memberIndex, imageUrl)] : []) : [],
    prevId: plates[index - 1]?.id ?? null,
    nextId: plates[index + 1]?.id ?? null,
  }
}
