'use client'

import { useId, useState, type CSSProperties } from 'react'
import Image from 'next/image'
import { cn } from '@/components/utils'
import type { BatchDetail } from '@/lib/client/hooks'
import { Button } from '@/components/ui/button'
import { pipelineFieldLabel } from '@/components/dashboard/pipeline-field-value'
import { PlateImageHover } from '@/components/plate/plate-image-preview'
import { sameEditableValue } from '@/lib/review/story'
import { draftGroupingFields } from '@/lib/review/fields'
import type { DraftChangeTarget, EditableFields, ProposedEdit } from '@/lib/review/types'
import type { Plate } from '@/lib/catalog/types'

const changeFields = {
  Edited: [
    'image',
    'imageUrl',
    'displayName',
    'description',
    'tags',
    'isStandard',
    'sourceUrl',
    'wikiUrl',
  ],
  Regrouped: ['templateFamily', 'templateRole', 'variantOfPlateId'],
  Reordered: ['sortOrder'],
}
const storyKeys = ['funFacts', 'firstIssuedYear', 'readMore', 'colorDetail', 'lineageColor']
const factText = (facts: unknown) => Array.isArray(facts) ? facts.map(fact =>
  fact && typeof fact === 'object' ? [fact.text, fact.sourceTitle, fact.sourceUrl].filter(Boolean).join('\n') : String(fact ?? '')).join('\n\n') : typeof facts === 'string' ? facts : undefined
const linkText = (links: unknown) => Array.isArray(links) ? links.map(link =>
  link && typeof link === 'object' ? `${link.title ?? ''} · ${link.site ?? ''}\n${link.url ?? ''}` : String(link ?? '')).join('\n\n') : undefined

export function changeSummary(
  before: Plate,
  after: Plate,
  order?: BatchDetail['plates'][number]['order'],
  group?: keyof typeof changeFields,
) {
  if (after.deleted && !before.deleted) return 'Deleted at next Publish'
  if (before.deleted && !after.deleted) return 'Restored at next Publish'
  const story = storyKeys
  const groupKeys = group ? [...changeFields[group], ...(group === 'Edited' ? story : [])] : null
  return (
    [
      'image',
      'imageUrl',
      'displayName',
      'description',
      'tags',
      'templateFamily',
      'templateRole',
      'variantOfPlateId',
      'sortOrder',
      'isStandard',
      'sourceUrl',
      'wikiUrl',
      ...story,
    ]
      .filter((key) => !groupKeys || groupKeys.includes(key))
      .flatMap((key) => {
        if (sameEditableValue(key, before[key], after[key]) || key === 'imageUrl' && before.image !== after.image)
          return []
        if (key === 'templateFamily')
          return [`moved to ${after.templateFamily ?? 'no family'}`]
        if (key === 'variantOfPlateId')
          return [
            after.variantOfPlateId == null
              ? 'variant link cleared'
              : `variant of ${after.variantOfPlateId}`,
          ]
        if (key === 'isStandard')
          return [after.isStandard ? 'now Standard' : 'no longer Standard']
        return [
          {
            imageUrl: 'image',
            displayName: 'name',
            templateRole: 'role',
            sortOrder: 'order',
            sourceUrl: 'links',
            wikiUrl: 'links',
          }[key] ?? key,
        ]
      })
      .concat(
        order
          ? [`reordered: ${order.before + 1} → ${order.after + 1}`]
          : [],
      )
      .join(', ') || 'No changes'
  )
}

const fieldsByRow: Record<string, (keyof EditableFields)[]> = {
  Status: ['deleted'],
  Image: ['imageUrl'],
  Description: ['description'],
  Tags: ['tags'],
  Family: ['templateFamily'],
  Role: ['templateRole'],
  'Variant of': ['variantOfPlateId'],
  Standard: ['isStandard'],
  'Fun facts': ['funFacts'],
  'First issued': ['firstIssuedYear'],
  'Read more': ['readMore'],
  'Background color': ['colorDetail'],
  'Broad color': ['lineageColor'],
  Links: ['wikiUrl'],
}

export function DiffTable({
  before,
  after,
  version,
  revision,
  order,
  positions,
  beforeImageUrl,
  afterImageUrl,
  pipelineChanges,
  onRevert,
  onDiscard,
  reverting,
  compact = false,
  preview = false,
}: {
  before: Plate
  after: Plate
  beforeImageUrl?: string | null
  afterImageUrl?: string | null
  version: number
  revision: number
  positions?: BatchDetail['plates'][number]['order']
  order: string[]
  pipelineChanges?: ProposedEdit['pipelineChanges']
  onRevert?(field: keyof EditableFields, jobId: string): void
  onDiscard?(target: DraftChangeTarget): void
  reverting?: boolean
  compact?: boolean
  preview?: boolean
}) {
  const [visibleSide, setVisibleSide] = useState<'before' | 'after'>('before')
  const comparisonId = useId()
  const hasStory = ['funFacts', 'firstIssuedYear', 'readMore'].some(key => before[key] != null || after[key] != null)
  const hasColors = ['colorDetail', 'lineageColor'].some(key => before[key] != null || after[key] != null)
  const position = (plate: Plate) =>
    order.includes(plate.id) ? `${order.indexOf(plate.id) + 1} of ${order.length}` : '—'
  const rows = [
    ['Status', before.deleted ? 'Deleted' : 'In catalog', after.deleted ? before.deleted ? 'Deleted' : 'Deleted at next Publish' : 'In catalog'],
    ['Image', before.image, after.image],
    ['Name', before.displayName, after.displayName],
    ['Description', before.description, after.description],
    ['Tags', before.tags, after.tags],
    ['Family', before.templateFamily, after.templateFamily],
    ['Role', before.templateRole, after.templateRole],
    [
      'Variant of',
      before.variantOfPlateId,
      after.variantOfPlateId == null && before.variantOfPlateId
        ? 'cleared'
        : after.variantOfPlateId,
    ],
    [
      'Order',
      positions
        ? `${positions.before + 1} of ${positions.total}`
        : position(before),
      positions
        ? `${positions.after + 1} of ${positions.total}`
        : before.sortOrder === after.sortOrder
          ? position(before)
          : `${(after.sortOrder ?? 0) + 1} of ${order.length}`,
    ],
    [
      'Standard',
      before.isStandard ? 'Yes' : 'No',
      after.isStandard ? 'Yes' : 'No',
    ],
    ['Rarity', 'not available', 'not available'],
    ['Fun facts', factText(before.funFacts), factText(after.funFacts)],
    ...(hasStory ? [
      ['First issued', before.firstIssuedYear, after.firstIssuedYear],
      ['Read more', linkText(before.readMore), linkText(after.readMore)],
    ] : []),
    ...(hasColors ? [
      ['Background color', before.colorDetail, after.colorDetail],
      ['Broad color', before.lineageColor, after.lineageColor],
    ] : []),
    [
      'Links',
      [before.sourceUrl, before.wikiUrl].filter(Boolean).join(', '),
      [after.sourceUrl, after.wikiUrl].filter(Boolean).join(', '),
    ],
  ]
  const imageChanged = before.image !== after.image || before.imageUrl !== after.imageUrl
  const changedField = (field: keyof EditableFields) => !sameEditableValue(field, before[field], after[field])
  const firstGrouping = draftGroupingFields.find(changedField)
  const updatedImage = changedField('imageUrl')
  function discardTargets(label: string): { target: DraftChangeTarget; label: string }[] {
    if (label === 'Order' && positions) return [{ target: 'order', label: 'order change' }]
    if (label === 'Image' && updatedImage) return [{ target: 'imageUrl', label: 'image change' }]
    const fields = label === 'Links' && !updatedImage ? ['sourceUrl', 'wikiUrl'] as const : fieldsByRow[label] ?? []
    return fields.flatMap(field => {
      if (!changedField(field) || field === 'imageUrl' || field === 'deleted' && Boolean(before.deleted) === Boolean(after.deleted)) return []
      if (draftGroupingFields.some(key => key === field)) return firstGrouping === field ? [{ target: field, label: 'grouping change' }] : []
      return [{ target: field, label: field === 'sourceUrl' ? 'source link change' : `${pipelineFieldLabel(field).toLowerCase()} change` }]
    })
  }
  const visibleRows = compact ? rows.filter(([label, oldValue, newValue]) =>
    (label === 'Image' && imageChanged) || JSON.stringify(oldValue ?? '') !== JSON.stringify(newValue ?? '') ||
    fieldsByRow[String(label)]?.some(field => pipelineChanges?.[field]?.previous !== undefined &&
      !sameEditableValue(field, pipelineChanges[field]?.previous, after[field]))) : rows
  return (
    <div className={cn('grid min-w-0 grid-cols-1 text-sm md:grid-cols-2', compact ? 'gap-2' : 'gap-4')} style={{ '--comparison-rows': Math.max(2, visibleRows.length + 1) } as CSSProperties}>
      {!preview && <div role="group" aria-label="Comparison view" className="flex rounded-full bg-muted p-1 md:hidden">
        {(['before', 'after'] as const).map(side => (
          <button
            key={side}
            type="button"
            aria-pressed={visibleSide === side}
            aria-controls={`${comparisonId}-${side}`}
            onClick={() => setVisibleSide(side)}
            className={cn('min-h-10 flex-1 rounded-full px-3 py-2 font-semibold', visibleSide === side && 'bg-primary text-primary-foreground')}
          >
            {side === 'before' ? 'Before' : 'After'}
          </button>
        ))}
      </div>}
      {(['before', 'after'] as const).map((side, index) => {
        const plate = side === 'before' ? before : after
        const imageUrl = side === 'before'
          ? beforeImageUrl
          : afterImageUrl ?? (imageChanged ? null : beforeImageUrl)
        const tint = side === 'before'
          ? 'bg-[var(--danger-tint)]'
          : 'bg-[var(--success-tint)]'
        return (
          <section key={side} id={`${comparisonId}-${side}`} aria-label={side === 'before' ? 'Before' : 'After'} className={cn('min-w-0 rounded-2xl border border-[var(--hairline)] bg-card md:grid md:grid-rows-subgrid md:[grid-row:span_var(--comparison-rows)]', compact ? 'gap-2 p-2.5' : 'gap-3 p-4', preview || visibleSide === side ? 'grid' : 'hidden')}>
            <h3 className="font-semibold">{side === 'before' ? `Before · Catalog v${version}` : `After · rev ${revision}`}</h3>
            {compact && !visibleRows.length && <p className="caption">No field differences</p>}
            {visibleRows.map(([label, oldValue, newValue]) => {
              const value = index === 0 ? oldValue : newValue
              const changed = JSON.stringify(oldValue ?? '') !== JSON.stringify(newValue ?? '')
              const otherTags = side === 'before' ? after.tags : before.tags
              const tags = label === 'Tags' ? (value as string[]).filter(tag => !compact || !otherTags.includes(tag)) : []
              return (
                <div key={String(label)} className={cn('min-w-0 border-t border-[var(--hairline)]', compact ? 'pt-2' : 'pt-3')}>
                  <p className="mb-2 text-xs font-semibold">{label}</p>
                  {label === 'Image' ? (
                    <div className={cn('relative flex aspect-[2/1] w-full max-w-44 items-center justify-center rounded-lg bg-[var(--fill)]', imageChanged && (side === 'before' ? 'ring-2 ring-[var(--danger)]' : 'ring-2 ring-[var(--success)]'))}>
                      {imageUrl ? (
                        <span className="absolute inset-0 grid">
                          <PlateImageHover plateId={plate.id} plateName={plate.displayName} before={imageUrl}>
                            <Image src={imageUrl} alt={plate.displayName} fill sizes="176px" unoptimized className="object-contain p-1" />
                          </PlateImageHover>
                        </span>
                      ) : (
                        <span className="break-all text-center text-xs">{String(value || 'none')}</span>
                      )}
                    </div>
                  ) : label === 'Tags' ? (
                    <div className="flex flex-wrap gap-2">
                      {tags.map((tag) => (
                        <span key={tag} className={cn(
                          'label min-w-0 max-w-full rounded-full px-3 py-1 [overflow-wrap:anywhere]',
                          !otherTags.includes(tag)
                            ? tint : 'bg-[var(--fill)]',
                        )}>{tag}</span>
                      ))}
                      {!tags.length && <span className="caption">None</span>}
                    </div>
                  ) : (
                    <span className={cn('whitespace-pre-wrap break-words [overflow-wrap:anywhere]', changed && tint)}>
                      {String(value || 'none')}
                    </span>
                  )}
                  {side === 'after' && onDiscard && discardTargets(String(label)).map(({ target, label }) => (
                    <Button key={target} variant="ghost" size="sm" className="mt-1 text-[var(--danger)]" disabled={reverting} onClick={() => onDiscard(target)}>
                      Remove {label}
                    </Button>
                  ))}
                  {side === 'after' && fieldsByRow[String(label)]?.map(field => {
                    const change = pipelineChanges?.[field]
                    if (!change || !sameEditableValue(field, change.value, after[field])) return null
                    const source = pipelineChanges?.sourceUrl
                    const imagePair = field === 'imageUrl'
                    const canRevertImage = Boolean(source?.jobId === change.jobId && sameEditableValue('sourceUrl', source?.value, after.sourceUrl))
                    const netChange = !sameEditableValue(field, before[field], after[field])
                      || imagePair && !sameEditableValue('sourceUrl', before.sourceUrl, after.sourceUrl)
                    const canRestorePrior = Object.hasOwn(change, 'previous') && !sameEditableValue(field, change.previous, after[field])
                      || imagePair && source && Object.hasOwn(source, 'previous') && !sameEditableValue('sourceUrl', source.previous, after.sourceUrl)
                    if (!netChange && !canRestorePrior) return null
                    return (
                      <div className="mt-2 flex flex-wrap items-center gap-2" key={field}>
                        {change.byName && <span className="caption">Pipeline · {change.byName}</span>}
                        {onRevert && (!imagePair || canRevertImage) && <Button variant="outline" size="sm" disabled={reverting} title={Object.hasOwn(change, 'previous') ? 'Restore the earlier draft value' : 'Restore the published value'} onClick={() => onRevert(field, change.jobId)}>
                          Revert {imagePair ? 'image and source' : pipelineFieldLabel(field).toLowerCase()}
                        </Button>}
                        {onRevert && imagePair && !canRevertImage && <span className="caption">The image and its source must be reverted together.</span>}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}

export function groupChanges(plates: BatchDetail['plates']) {
  const changed = (entry: BatchDetail['plates'][number], keys: string[]) =>
    !entry.proposed.deleted && keys.some(
      (key) =>
        JSON.stringify(entry.baseline[key]) !==
        JSON.stringify(entry.proposed[key]),
    )
  return {
    Deleted: plates.filter(entry => entry.proposed.deleted === true),
    Edited: plates.filter((entry) => changed(entry, [...changeFields.Edited, ...storyKeys])),
    Regrouped: plates.filter((entry) => changed(entry, changeFields.Regrouped)),
    Reordered: plates.filter((entry) =>
      !entry.proposed.deleted && (entry.order !== undefined || changed(entry, changeFields.Reordered)),
    ),
  }
}
