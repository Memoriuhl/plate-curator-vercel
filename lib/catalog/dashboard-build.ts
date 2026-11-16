import { plateRevision } from '../review/revision'
import { COMPLETENESS_CHECK_KEYS, PLATE_IMAGE_SIZE } from './dashboard-types'
import type { Check, DashboardData, JurisdictionData, PlateCardData, PlateChecks, PlateDetail } from './dashboard-types'
import { JURISDICTIONS } from './jurisdictions'
import { orderedStatePlates } from './order'
import type { CatalogSource, CuratorState, Plate, Snapshot } from './types'

type ImageUrl = CatalogSource['imageUrl']

const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null
const check = (value: string | null, weak = false): Check => ({ status: value === null ? 'missing' : weak ? 'weak' : 'good', value })

function plateCard(plate: Plate, index: number, imageUrl: ImageUrl): PlateCardData {
  const url = imageUrl(plate)
  const description = text(plate.description)
  const sourceUrl = text(plate.sourceUrl)
  const wikiUrl = text(plate.wikiUrl)
  const family = text(plate.templateFamily)
  const role = plate.templateRole ?? null
  const facts = Array.isArray(plate.funFacts) && plate.funFacts.length > 0 ? plate.funFacts.join('\n') : text(plate.funFacts)
  const rarity = typeof plate.rarity === 'object' && plate.rarity !== null && 'tier' in plate.rarity ? text(plate.rarity.tier) : text(plate.rarity)
  const checks: PlateChecks = {
    description: check(description, (description?.length ?? 0) < 40),
    funFacts: check(facts),
    link: check(sourceUrl ?? wikiUrl, sourceUrl === null),
    tags: check(plate.tags.length > 0 ? plate.tags.join(', ') : null, plate.tags.length < 3),
    family: check(family ? role ? `${family} · ${role}` : family : null, role === null),
    image: check(url),
    rarity: check(rarity),
  }
  return {
    id: plate.id, state: plate.state, slug: plate.slug, displayName: plate.displayName,
    imageUrl: url, imageSize: PLATE_IMAGE_SIZE, tags: plate.tags,
    templateFamily: family, templateRole: role, variantOfPlateId: plate.variantOfPlateId ?? null,
    isStandard: plate.isStandard ?? false, sortOrder: plate.sortOrder ?? index,
    revision: plateRevision(plate), checks,
    complete: COMPLETENESS_CHECK_KEYS.every(key => checks[key].status === 'good'),
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
  return { ...jurisdiction(code), plates: plates.map((plate, index) => plateCard(plate, index, imageUrl)) }
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
    },
    family: plate.templateFamily ? plates.flatMap((member, memberIndex) =>
      member.templateFamily === plate.templateFamily ? [plateCard(member, memberIndex, imageUrl)] : []) : [],
    prevId: plates[index - 1]?.id ?? null,
    nextId: plates[index + 1]?.id ?? null,
  }
}
