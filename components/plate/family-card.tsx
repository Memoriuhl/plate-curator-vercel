import Image from 'next/image'
import { IoReorderThreeOutline, IoStar } from 'react-icons/io5'

import { cn } from '@/components/utils'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'

import { CheckStrip } from './check-strip'

export type FamilyCardProps = {
  template: PlateCardData
  variants: PlateCardData[]
  groupingNote?: string
}

type PlateThumbnailProps = {
  plate: PlateCardData
  width: number
  height: number
  className?: string
}

function PlateThumbnail({ plate, width, height, className }: PlateThumbnailProps) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-[var(--fill)] text-[var(--ink-3)]',
        className,
      )}
      style={{ width, height }}
    >
      {plate.imageUrl ? (
        <Image
          src={plate.imageUrl}
          alt={`${plate.displayName} plate`}
          width={width}
          height={height}
          className='size-full object-contain'
            unoptimized
        />
      ) : (
        <span className='caption text-center'>No image</span>
      )}
    </div>
  )
}

function PlateIdentity({ plate }: { plate: PlateCardData }) {
  return (
    <div className='flex min-w-0 flex-1 basis-44 flex-col gap-[var(--space-1)]'>
      <div className='flex items-start justify-between gap-[var(--space-2)]'>
        <h3 className='plate-name min-w-0 whitespace-normal break-words text-[var(--ink)]'>
          {plate.displayName}
        </h3>
        {plate.isStandard ? (
          <span
            className='shrink-0 text-[var(--primary)]'
            aria-label='Standard plate'
            title='Standard plate'
          >
            <IoStar aria-hidden='true' />
          </span>
        ) : null}
      </div>
      <p className='id whitespace-normal break-all font-mono text-[var(--ink-2)]'>{plate.id}</p>
      <CheckStrip checks={plate.checks} />
    </div>
  )
}

export function FamilyCard({ template, variants, groupingNote }: FamilyCardProps) {
  return (
    <article aria-label={`${template.displayName} family`} className='flex flex-col gap-[var(--space-3)] rounded-[var(--radius-lg)] bg-[var(--card)] p-[var(--space-4)] text-[var(--ink)]'>
      <div className='flex flex-wrap items-start gap-[var(--space-3)]'>
        <span
          className='flex shrink-0 items-center justify-center text-[var(--ink-3)]'
          aria-hidden='true'
        >
          <IoReorderThreeOutline size={20} />
        </span>
        <PlateThumbnail plate={template} width={140} height={70} />
        <PlateIdentity plate={template} />
      </div>

      {variants.length > 0 ? (
        <div className='flex flex-col gap-[var(--space-2)] pl-[var(--space-8)]'>
          {variants.map((variant) => (
            <div
              key={variant.id}
              className='flex flex-wrap items-start gap-[var(--space-3)]'
            >
              <PlateThumbnail plate={variant} width={84} height={42} />
              <PlateIdentity plate={variant} />
            </div>
          ))}
        </div>
      ) : null}

      {groupingNote ? (
        <p className='caption whitespace-normal break-words text-[var(--ink-2)]'>{groupingNote}</p>
      ) : null}
    </article>
  )
}
