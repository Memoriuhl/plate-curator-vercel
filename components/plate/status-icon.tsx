'use client'

import { useId, useState } from 'react'
import { IoDocumentTextOutline, IoBulbOutline, IoLinkOutline, IoPricetagsOutline, IoGitNetworkOutline, IoImageOutline, IoDiamondOutline, IoRemoveOutline } from 'react-icons/io5'
import type { Check, PlateCheckKey } from '@/lib/catalog/dashboard-types'
import { cn } from '@/components/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const checks = {
  description: { label: 'Description', icon: IoDocumentTextOutline },
  funFacts: { label: 'Fun facts', icon: IoBulbOutline },
  link: { label: 'Link', icon: IoLinkOutline },
  tags: { label: 'Tags', icon: IoPricetagsOutline },
  family: { label: 'Family', icon: IoGitNetworkOutline },
  image: { label: 'Image', icon: IoImageOutline },
  rarity: { label: 'Rarity', icon: IoDiamondOutline },
}

export function StatusIcon({ checkKey, check }: { checkKey: PlateCheckKey; check: Check }) {
  const [open, setOpen] = useState(false)
  const valueId = useId()
  const { label, icon: Icon } = checks[checkKey]
  return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={`${label}: ${check.status}`} aria-describedby={open ? valueId : undefined}
            onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
            onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
            className={cn(
            'relative inline-flex size-[26px] shrink-0 items-center justify-center bg-transparent p-0',
            check.status === 'good' && 'text-[var(--success)]',
            check.status === 'weak' && 'text-[var(--warning)]',
            check.status === 'missing' && 'text-[var(--danger)]',
          )}>
            <Icon size={20} aria-hidden="true" />
            {check.status === 'weak' && <span aria-hidden="true" data-status-dot="" className="absolute right-0 bottom-0 size-1 rounded-full bg-current" />}
            {check.status === 'missing' && <IoRemoveOutline aria-hidden="true" data-status-slash="" size={24} className="absolute rotate-45" />}
          </button>
        </PopoverTrigger>
        {open && <PopoverContent id={valueId} role="tooltip" side="top" onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()} className="whitespace-pre-wrap break-words">{check.value ?? `${label}: no value`}</PopoverContent>}
      </Popover>
  )
}
