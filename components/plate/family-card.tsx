'use client'

import Image from 'next/image'
import { preconnect } from 'react-dom'
import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  IoReorderThreeOutline,
  IoStar,
  IoInformationCircleOutline,
} from 'react-icons/io5'
import { cn } from '@/components/utils'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import { CheckStrip } from './check-strip'
import { VirtualizedVariants } from './virtualized-variants'

export type FamilyCardProps = {
  template: PlateCardData
  variants: PlateCardData[]
  groupingNote?: string
  number?: number
  matches?: (plate: PlateCardData) => boolean
  badge?: (plate: PlateCardData) => ReactNode
  onPreview?: (
    plate: PlateCardData,
    element: HTMLElement,
    immediate: boolean,
  ) => void
  onClosePreview?: () => void
}

export function FamilyCard({
  template,
  variants,
  groupingNote,
  number,
  matches,
  badge,
  onPreview,
  onClosePreview,
}: FamilyCardProps) {
  if (number === 1 && template.imageUrl?.startsWith('https:'))
    preconnect(new URL(template.imageUrl).origin)
  function plateContent(plate: PlateCardData, small: boolean) {
    const width = small ? 84 : 140
    const height = small ? 42 : 70
    return (
      <div
        key={plate.id}
        className={cn(
          'relative flex items-start gap-3',
          matches && !matches(plate) && 'opacity-35',
        )}
      >
        <Link
          prefetch={false}
          href={'/plates/' + plate.id}
          className="flex min-w-0 flex-1 flex-wrap items-start gap-3 rounded-[var(--radius-sm)] focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
          onMouseEnter={(event) =>
            onPreview?.(plate, event.currentTarget, false)
          }
          onMouseLeave={onClosePreview}
          onFocus={(event) => onPreview?.(plate, event.currentTarget, true)}
          onBlur={onClosePreview}
        >
          <div
            style={{ width, height }}
            className="flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-[var(--fill)] text-[var(--ink-3)]"
          >
            {plate.imageUrl ? (
              <Image
                src={plate.imageUrl}
                alt={plate.displayName + ' plate'}
                width={width}
                height={height}
                loading={!small && number === 1 ? 'eager' : 'lazy'}
                fetchPriority={!small && number === 1 ? 'high' : 'auto'}
                unoptimized
                className="size-full object-contain"
              />
            ) : (
              <span className="caption">No image</span>
            )}
          </div>
          <div className="flex min-w-0 flex-1 basis-36 flex-col gap-1">
            <div className="flex items-start justify-between gap-2">
              <h3 className="plate-name whitespace-normal break-words">
                {plate.displayName}
              </h3>
              {plate.isStandard ? (
                <span
                  aria-label="Standard plate"
                  title="Standard plate"
                  className="text-[var(--warning)]"
                >
                  <IoStar aria-hidden="true" />
                </span>
              ) : null}
            </div>
            <p className="id break-all font-mono text-[var(--ink-2)]">
              {plate.id}
            </p>
            <CheckStrip checks={plate.checks} />
          </div>
          {badge?.(plate)}
        </Link>
        {onPreview ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={'Preview ' + plate.displayName}
            onClick={(event) => onPreview(plate, event.currentTarget, true)}
            className="absolute right-0 bottom-0 text-[var(--ink-2)]"
          >
            <IoInformationCircleOutline />
          </button>
        ) : null}
      </div>
    )
  }
  return (
    <article
      aria-label={template.displayName + ' family'}
      className="flex flex-col gap-3 rounded-[var(--radius-lg)] bg-[var(--card)] p-4 text-[var(--ink)]"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex shrink-0 flex-col items-center rounded-[var(--radius-sm)] bg-[var(--fill)] p-1 text-[var(--ink-3)]"
        >
          <IoReorderThreeOutline size={20} />
          {number}
        </span>
        <div className="min-w-0 flex-1">{plateContent(template, false)}</div>
      </div>
      {variants.length ? (
        <div className="flex flex-col gap-3 pl-8">
          {variants.length > 12 ? (
            <VirtualizedVariants
              plates={variants}
              renderPlate={(plate) => plateContent(plate, true)}
            />
          ) : (
            variants.map((plate) => plateContent(plate, true))
          )}
        </div>
      ) : null}
      {groupingNote ? (
        <p className="caption whitespace-normal break-words text-[var(--ink-2)]">
          {groupingNote}
        </p>
      ) : null}
    </article>
  )
}
