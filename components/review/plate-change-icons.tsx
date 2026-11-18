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
import { sameEditableValue } from '@/lib/review/story'

const changes = [
  { fields: ['image', 'imageUrl'], ...CHECK_META.image },
  { fields: ['description'], ...CHECK_META.description },
  { fields: ['displayName'], label: 'Name', icon: IoTextOutline },
  { fields: ['funFacts'], ...CHECK_META.funFacts },
  { fields: ['tags'], ...CHECK_META.tags },
  { fields: ['wikiUrl', 'readMore', 'sourceUrl'], ...CHECK_META.link },
  {
    fields: [
      'templateFamily',
      'templateRole',
      'variantOfPlateId',
      'isStandard',
    ],
    ...CHECK_META.family,
  },
  {
    fields: ['firstIssuedYear'],
    label: 'First issued',
    icon: IoCalendarOutline,
    IoTextOutline,
  },
  {
    fields: ['colorDetail', 'lineageColor'],
    label: 'Colors',
    icon: IoColorPaletteOutline,
  },
] as const

export function PlateChangeIcons({
  entry,
}: {
  entry: BatchDetail['plates'][number]
}) {
  const { baseline, proposed, order } = entry
  const indicators: { label: string; icon: IconType }[] = changes
    .filter(({ fields }) =>
      fields.some(
        (field) => !sameEditableValue(field, baseline[field], proposed[field])
      )
    )
    .map(({ label, icon }) => ({ label, icon }))
  if (order || baseline.sortOrder !== proposed.sortOrder)
    indicators.push({ label: 'Order', icon: IoSwapVerticalOutline })
  if (!!baseline.deleted !== !!proposed.deleted)
    indicators.push({
      label: proposed.deleted ? 'Deleted' : 'Restored',
      icon: IoTrashOutline,
    })
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
