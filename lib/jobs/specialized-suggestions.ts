import type { EditableFields } from '../review/types'
import { commonsImageUrl, commonsSourceUrl } from './image-options'

export type ImageCandidate = { id: string; imageUrl: string; sourceUrl: string; title: string; width: number; height: number; sha256: string; license?: string; author?: string }
export type ImageSuggestion = { kind: 'image'; stage: 'find-image'; candidates: ImageCandidate[]; sources: string[] }
export type GroupFields = Required<Pick<EditableFields, 'templateFamily' | 'templateRole' | 'variantOfPlateId'>>
export type GroupMember = { plateId: string; baseRevision: string }
export type GroupProposal = GroupMember & { fields: GroupFields }
export type GroupSuggestion = { kind: 'group'; stage: 'group'; scope: GroupMember[]; proposals: GroupProposal[]; sources: string[] }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max
const member = (value: unknown): value is GroupMember => record(value) && text(value.plateId, 120) && /^[a-f0-9]{20}$/.test(String(value.baseRevision))

export function parseImageSuggestion(input: unknown): ImageSuggestion | null {
  if (!record(input) || !exact(input, ['kind', 'stage', 'candidates', 'sources']) || input.kind !== 'image' || input.stage !== 'find-image') return null
  if (!Array.isArray(input.candidates) || !input.candidates.length || input.candidates.length > 5 || !Array.isArray(input.sources) || input.sources.length > 10) return null
  const candidates: ImageCandidate[] = []
  for (const value of input.candidates) {
    if (!record(value) || Object.keys(value).some(key => !['id', 'imageUrl', 'sourceUrl', 'title', 'width', 'height', 'sha256', 'license', 'author'].includes(key)) || !text(value.id, 120) || !text(value.title, 300)) return null
    if (!Number.isInteger(value.width) || !Number.isInteger(value.height) || Number(value.width) < 80 || Number(value.height) < 40 || Number(value.width) * Number(value.height) > 16000000 || !/^[a-f0-9]{64}$/.test(String(value.sha256))) return null
    if (value.license !== undefined && !text(value.license, 500) || value.author !== undefined && !text(value.author, 500)) return null
    const imageUrl = commonsImageUrl(value.imageUrl)
    const sourceUrl = commonsSourceUrl(value.sourceUrl)
    if (!imageUrl || !sourceUrl || !input.sources.includes(imageUrl) || !input.sources.includes(sourceUrl)) return null
    candidates.push({ id: value.id, imageUrl, sourceUrl, title: value.title, width: Number(value.width), height: Number(value.height), sha256: String(value.sha256), ...(value.license ? { license: value.license as string } : {}), ...(value.author ? { author: value.author as string } : {}) })
  }
  if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length || new Set(candidates.map(candidate => candidate.imageUrl)).size !== candidates.length) return null
  const sources = [...new Set(candidates.flatMap(candidate => [candidate.imageUrl, candidate.sourceUrl]))].sort()
  if (input.sources.some(source => !sources.includes(source))) return null
  return { kind: 'image', stage: 'find-image', candidates, sources }
}

export function parseGroupSuggestion(input: unknown): GroupSuggestion | null {
  if (!record(input) || !exact(input, ['kind', 'stage', 'scope', 'proposals', 'sources']) || input.kind !== 'group' || input.stage !== 'group') return null
  if (!Array.isArray(input.scope) || !input.scope.length || input.scope.length > 25 || !input.scope.every(value => member(value) && exact(value as Record<string, unknown>, ['plateId', 'baseRevision']))) return null
  const scope = input.scope as GroupMember[]
  if (new Set(scope.map(value => value.plateId)).size !== scope.length) return null
  if (!Array.isArray(input.proposals) || input.proposals.length !== scope.length || !Array.isArray(input.sources) || input.sources.length) return null
  const proposals: GroupProposal[] = []
  for (const value of input.proposals) {
    if (!member(value) || !record(value) || !exact(value, ['plateId', 'baseRevision', 'fields'])) return null
    if (!scope.some(entry => entry.plateId === value.plateId && entry.baseRevision === value.baseRevision)) return null
    const fields = (value as unknown as Record<string, unknown>).fields
    if (!record(fields) || !exact(fields, ['templateFamily', 'templateRole', 'variantOfPlateId']) || !text(fields.templateFamily, 120)) return null
    if (fields.templateRole !== 'template' && fields.templateRole !== 'variant') return null
    if (fields.templateRole === 'template' ? fields.variantOfPlateId !== null : !text(fields.variantOfPlateId, 120) || fields.variantOfPlateId === value.plateId) return null
    proposals.push({ plateId: value.plateId, baseRevision: value.baseRevision, fields: fields as GroupFields })
  }
  if (new Set(proposals.map(value => value.plateId)).size !== scope.length) return null
  const families = new Map<string, GroupProposal[]>()
  for (const proposal of proposals) families.set(proposal.fields.templateFamily, [...families.get(proposal.fields.templateFamily) ?? [], proposal])
  for (const family of families.values()) {
    const templates = family.filter(value => value.fields.templateRole === 'template')
    if (templates.length !== 1 || family.some(value => value.fields.templateRole === 'variant' && value.fields.variantOfPlateId !== templates[0].plateId)) return null
  }
  return { kind: 'group', stage: 'group', scope: [...scope].sort((a, b) => a.plateId.localeCompare(b.plateId)), proposals: proposals.sort((a, b) => a.plateId.localeCompare(b.plateId)), sources: [] }
}
