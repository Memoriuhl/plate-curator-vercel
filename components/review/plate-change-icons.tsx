'use client'

import type { IconType } from 'react-icons'
import { Tooltip } from 'radix-ui'
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
  changeDetail,
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

/**
 * Show one icon per kind of change. Hovering an icon shows what changed, like the
 * Dashboard's check tooltips.
 */
export function PlateChangeIcons(
  props: { entry: PlateChange } | { entries: readonly PlateChange[] }
) {
  const entries = 'entries' in props ? props.entries : [props.entry]
  const changes = new Map(
    entries.flatMap((entry) =>
      plateChanges(entry).map(
        (change) => [change.key, { change, entry }] as const
      )
    )
  )
  const indicators = keyOrder.flatMap((key) => {
    const found = changes.get(key)
    if (!found) return []
    return [
      {
        key,
        label: found.change.label,
        icon: CHANGE_ICONS[key],
        detail: changeDetail(found.entry, key),
      },
    ]
  })
  if (!indicators.length) return null
  return (
    // Its own provider, with the app's delay, so the icons work wherever they render.
    <Tooltip.Provider delayDuration={300}>
      <span className="flex flex-wrap gap-1 text-muted-foreground">
        {indicators.map(({ key, label, icon: Icon, detail }) => (
          <Tooltip.Root key={key}>
            <Tooltip.Trigger asChild>
              <span
                role="img"
                aria-label={`${label} changed`}
                data-change={key}
                className="inline-flex size-4 items-center justify-center"
              >
                <Icon className="size-3.5" aria-hidden="true" />
              </span>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                side="top"
                sideOffset={6}
                collisionPadding={8}
                data-change-tooltip
                className="z-50 w-max max-w-72 rounded-[var(--radius-md)] bg-[var(--card)] p-3 text-xs text-[var(--ink)] shadow-xl ring-1 ring-[var(--border)]"
              >
                <p className="mb-1 font-medium">
                  {label}{' '}
                  <span className="font-normal text-[var(--ink-2)]">
                    · changed
                  </span>
                </p>
                {detail.map((line) => (
                  <p key={line} className="break-words">
                    {line}
                  </p>
                ))}
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        ))}
      </span>
    </Tooltip.Provider>
  )
}
