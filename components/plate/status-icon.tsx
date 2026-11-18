import {
  IoDocumentTextOutline,
  IoBulbOutline,
  IoLinkOutline,
  IoPricetagsOutline,
  IoGitNetworkOutline,
  IoImageOutline,
  IoDiamondOutline,
  IoRemoveOutline,
} from 'react-icons/io5'
import type { Check, PlateCheckKey } from '@/lib/catalog/dashboard-types'
import { cn } from '@/components/utils'

export const CHECK_META = {
  description: { label: 'Description', icon: IoDocumentTextOutline },
  funFacts: { label: 'Fun facts', icon: IoBulbOutline },
  link: { label: 'Link', icon: IoLinkOutline },
  tags: { label: 'Tags', icon: IoPricetagsOutline },
  family: { label: 'Family', icon: IoGitNetworkOutline },
  image: { label: 'Image', icon: IoImageOutline },
  rarity: { label: 'Rarity', icon: IoDiamondOutline },
} as const

/** Render the current result for one completeness check with a readable status label. */
export function StatusIcon({
  checkKey,
  check,
}: {
  checkKey: PlateCheckKey
  check: Check
}) {
  const { label, icon: Icon } = CHECK_META[checkKey]
  return (
    <span
      role="img"
      aria-label={`${label}: ${check.status}`}
      data-check={checkKey}
      className={cn(
        'relative inline-flex size-[26px] shrink-0 items-center justify-center',
        check.status === 'good' && 'text-[var(--success)]',
        check.status === 'weak' && 'text-[var(--warning)]',
        check.status === 'missing' && 'text-[var(--danger)]'
      )}
    >
      <Icon size={20} aria-hidden="true" />
      {check.status === 'missing' && (
        <IoRemoveOutline
          aria-hidden="true"
          data-status-slash=""
          size={24}
          className="absolute rotate-45"
        />
      )}
    </span>
  )
}
