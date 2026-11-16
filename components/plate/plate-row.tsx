import Image from 'next/image'

import { cn } from '@/components/utils'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'

import { CheckStrip } from './check-strip'

const THUMBNAIL = { width: 72, height: 36 } as const

export type PlateRowProps = {
  plate: PlateCardData
}

export function PlateRow({ plate }: PlateRowProps) {
  return (
    <div
      className='grid grid-cols-[auto_minmax(0,1fr)] items-center gap-[var(--space-3)] rounded-[var(--radius-lg)] p-[var(--space-2)] text-[var(--ink)] transition-colors hover:bg-[var(--fill)] sm:grid-cols-[auto_minmax(0,1fr)_auto]'
    >
      <div
        className={cn(
          'flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-[var(--fill)] text-[var(--ink-3)]',
        )}
        style={THUMBNAIL}
      >
        {plate.imageUrl ? (
          <Image
            src={plate.imageUrl}
            alt={`${plate.displayName} plate`}
            width={THUMBNAIL.width}
            height={THUMBNAIL.height}
            className='size-full object-contain'
          />
        ) : (
          <span className='caption text-center'>No image</span>
        )}
      </div>

      <div className='flex min-w-0 flex-1 flex-col gap-[var(--space-1)]'>
        <p className='plate-name whitespace-normal break-words text-[var(--ink)]'>
          {plate.displayName}
        </p>
        <p className='id whitespace-normal break-all font-mono text-[var(--ink-2)]'>{plate.id}</p>
      </div>

      <div className='col-span-2 flex min-w-0 items-start sm:col-span-1'>
        <CheckStrip checks={plate.checks} />
      </div>
    </div>
  )
}
