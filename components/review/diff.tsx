import type { BatchDetail } from '@/lib/client/hooks'
import type { Plate } from '@/lib/catalog/types'

export function changeSummary(
  before: Plate,
  after: Plate,
  order?: BatchDetail['plates'][number]['order'],
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
      .flatMap((key) => {
        if (JSON.stringify(before[key]) === JSON.stringify(after[key]))
          return []
        if (key === 'templateFamily')
          return [`moved to ${after.templateFamily ?? 'no family'}`]
        if (key === 'variantOfPlateId')
          return [after.variantOfPlateId == null ? 'variant link cleared' : `variant of ${after.variantOfPlateId}`]
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
      .concat(order && order.before !== order.after ? [`reordered: ${order.before + 1} → ${order.after + 1}`] : [])
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
}: {
  before: Plate
  after: Plate
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
    ['Variant of', before.variantOfPlateId, after.variantOfPlateId == null && before.variantOfPlateId ? 'cleared' : after.variantOfPlateId],
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
  return (
    <table className="w-full table-fixed text-left text-xs">
      <thead>
        <tr className="text-muted-foreground">
          <th className="w-[18%] p-2">Field</th>
          <th className="w-[41%] p-2">Before · live v{version}</th>
          <th className="p-2">After · rev {revision}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, oldValue, newValue]) => {
          const changed =
            JSON.stringify(oldValue ?? '') !== JSON.stringify(newValue ?? '')
          const format = (value: unknown, side: 'before' | 'after') => {
            if (label === 'Tags') {
              const tags = value as string[]
              const other = (
                side === 'before' ? newValue : oldValue
              ) as string[]
              const diff = tags.filter((tag) => !other.includes(tag))
              return `${tags.length}${diff.length ? ` · ${side === 'before' ? 'removed' : 'added'}: ${diff.join(', ')}` : ''}`
            }
            return String(value || 'none')
          }
          return (
            <tr
              key={String(label)}
              className="border-t border-[var(--hairline)] align-top"
            >
              <th className="break-words p-2 py-3">{label}</th>
              <td className="break-words p-2 py-3">
                <span
                  className={
                    changed
                      ? 'bg-[var(--danger-tint)] line-through'
                      : 'text-muted-foreground'
                  }
                >
                  {format(oldValue, 'before')}
                </span>
              </td>
              <td className="break-words p-2 py-3">
                <span
                  className={
                    changed
                      ? 'bg-[var(--success-tint)]'
                      : 'text-muted-foreground'
                  }
                >
                  {changed ? format(newValue, 'after') : 'unchanged'}
                </span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
