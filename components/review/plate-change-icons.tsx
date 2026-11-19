import type { IconType } from 'react-icons'
import {
  IoSwapVerticalOutline,
  IoTrashOutline,
  IoColorPaletteOutline,
  IoCalendarOutline,
  IoTextOutline,
} from 'react-icons/io5'
import { CHECK_META } from '@/components/plate/status-icon'
import type { BatchDetail } from '@/lib/client/hooks'
import {
  FIELD_CHANGES,
  plateChanges,
  type PlateChangeKey,
} from '@/lib/review/plate-changes'

/** The icon Review and Publish show for each kind of plate change. */
export const CHANGE_ICONS: Record<PlateChangeKey, IconType> = {
  image: CHECK_META.image.icon,
  description: CHECK_META.description.icon,
  name: IoTextOutline,
  funFacts: CHECK_META.funFacts.icon,
  tags: CHECK_META.tags.icon,
  link: CHECK_META.link.icon,
  family: CHECK_META.family.icon,
  firstIssued: IoCalendarOutline,
  colors: IoColorPaletteOutline,
  order: IoSwapVerticalOutline,
  deleted: IoTrashOutline,
  restored: IoTrashOutline,
}

const keyOrder: PlateChangeKey[] = [
  ...FIELD_CHANGES.map((change) => change.key),
  'order',
  'deleted',
  'restored',
]

type PlateChange = BatchDetail['plates'][number]

export function PlateChangeIcons(
  props: { entry: PlateChange } | { entries: readonly PlateChange[] }
) {
  const entries = 'entries' in props ? props.entries : [props.entry]
  const labels = new Map(
    entries.flatMap(plateChanges).map((change) => [change.key, change.label])
  )
  const indicators = keyOrder.flatMap((key) =>
    labels.has(key)
      ? [{ label: labels.get(key)!, icon: CHANGE_ICONS[key] }]
      : []
  )
  if (!indicators.length) return null
  return (
    <span className="flex flex-wrap gap-1 text-muted-foreground">
      {indicators.map(({ label, icon: Icon }) => (
        <span
          key={label}
          role="img"
          aria-label={`${label} changed`}
          title={label}
          className="inline-flex size-4 items-center justify-center"
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
      ))}
    </span>
  )
}
