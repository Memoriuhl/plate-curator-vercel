import Image from 'next/image'
import { cn } from '@/components/utils'
import type { BatchDetail } from '@/lib/client/hooks'
import type { Plate } from '@/lib/catalog/types'

const changeFields = {
  Edited: [
    'image',
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

export function changeSummary(
  before: Plate,
  after: Plate,
  order?: BatchDetail['plates'][number]['order'],
  group?: keyof typeof changeFields,
) {
  return (
    [
      'image',
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
    ]
      .filter((key) => !group || changeFields[group].includes(key))
      .flatMap((key) => {
        if (JSON.stringify(before[key]) === JSON.stringify(after[key]))
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
            displayName: 'name',
            templateRole: 'role',
            sortOrder: 'order',
            sourceUrl: 'links',
            wikiUrl: 'links',
          }[key] ?? key,
        ]
      })
      .concat(
        order && order.before !== order.after
          ? [`reordered: ${order.before + 1} → ${order.after + 1}`]
          : [],
      )
      .join(', ') || 'No changes'
  )
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
}: {
  before: Plate
  after: Plate
  beforeImageUrl?: string | null
  afterImageUrl?: string | null
  version: number
  revision: number
  positions?: BatchDetail['plates'][number]['order']
  order: string[]
}) {
  const position = (plate: Plate) =>
    `${order.indexOf(plate.id) + 1} of ${order.length}`
  const rows = [
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
    ['Fun facts', 'none', 'none'],
    [
      'Links',
      [before.sourceUrl, before.wikiUrl].filter(Boolean).join(', '),
      [after.sourceUrl, after.wikiUrl].filter(Boolean).join(', '),
    ],
  ]
  const imageChanged = before.image !== after.image
  return (
    <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
      {(['before', 'after'] as const).map((side, index) => {
        const plate = side === 'before' ? before : after
        const imageUrl = side === 'before'
          ? beforeImageUrl
          : afterImageUrl ?? (imageChanged ? null : beforeImageUrl)
        const tint = side === 'before'
          ? 'bg-[var(--danger-tint)]'
          : 'bg-[var(--success-tint)]'
        return (
          <section key={side} aria-label={side === 'before' ? 'Before' : 'After'} className="grid min-w-0 gap-3 rounded-2xl border border-[var(--hairline)] bg-card p-4 md:row-span-13 md:grid-rows-subgrid">
            <h3 className="font-semibold">{side === 'before' ? `Before · live v${version}` : `After · rev ${revision}`}</h3>
            {rows.map(([label, oldValue, newValue]) => {
              const value = index === 0 ? oldValue : newValue
              const changed = JSON.stringify(oldValue ?? '') !== JSON.stringify(newValue ?? '')
              return (
                <div key={String(label)} className="min-w-0 border-t border-[var(--hairline)] pt-3">
                  <p className="mb-2 text-xs font-semibold">{label}</p>
                  {label === 'Image' ? (
                    <div className={cn('relative flex aspect-[2/1] items-center justify-center rounded-xl bg-[var(--fill)] p-3', imageChanged && (side === 'before' ? 'ring-2 ring-[var(--danger-tint)]' : 'ring-2 ring-[var(--success-tint)]'))}>
                      {imageUrl ? (
                        <Image src={imageUrl} alt={plate.displayName} fill unoptimized className="object-contain p-3" />
                      ) : (
                        <span className="break-all text-center text-xs">{String(value || 'none')}</span>
                      )}
                    </div>
                  ) : label === 'Tags' ? (
                    <div className="flex flex-wrap gap-2">
                      {(value as string[]).length ? (value as string[]).map((tag) => (
                        <span key={tag} className={cn(
                          'label rounded-full px-3 py-1',
                          !(side === 'before' ? after.tags : before.tags).includes(tag)
                            ? tint : 'bg-[var(--fill)]',
                        )}>{tag}</span>
                      )) : 'none'}
                    </div>
                  ) : (
                    <span className={cn('whitespace-pre-wrap break-words [overflow-wrap:anywhere]', changed && tint)}>
                      {String(value || 'none')}
                    </span>
                  )}
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
    keys.some(
      (key) =>
        JSON.stringify(entry.baseline[key]) !==
        JSON.stringify(entry.proposed[key]),
    )
  return {
    Edited: plates.filter((entry) => changed(entry, changeFields.Edited)),
    Regrouped: plates.filter((entry) => changed(entry, changeFields.Regrouped)),
    Reordered: plates.filter((entry) =>
      entry.order
        ? entry.order.before !== entry.order.after
        : changed(entry, changeFields.Reordered),
    ),
  }
}
