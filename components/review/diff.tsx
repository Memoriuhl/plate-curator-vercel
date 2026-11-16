import type { Plate } from '@/lib/catalog/types'

export function changeSummary(before: Plate, after: Plate) {
  return (
    [
      'image',
      'displayName',
      'description',
      'tags',
      'templateFamily',
      'templateRole',
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
      .join(', ') || 'No changes'
  )
}

export function DiffTable({
  before,
  after,
  version,
  revision,
  order,
}: {
  before: Plate
  after: Plate
  version: number
  revision: number
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
      'Order',
      position(before),
      before.sortOrder === after.sortOrder
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
