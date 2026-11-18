import { IoDiamond, IoDiamondOutline } from 'react-icons/io5'

const tiers = ['Local', 'Regular', 'Out-of-Towner', 'Long Hauler', 'Rare Bird', 'Holy Grail'] as const

/** Display the plate's rarity tier with a marker and a readable label. */
export function RarityMark({ tier = null, source = 'Estimated' }: { tier?: 1 | 2 | 3 | 4 | 5 | 6 | null; source?: 'Estimated' | 'Observed' | 'Manual' }) {
  const label = tier === null ? 'Rarity: not available' : `${tiers[tier - 1]} · ${source}`
  const Icon = source === 'Observed' ? IoDiamond : IoDiamondOutline
  return (
    <span className="label inline-flex items-center gap-2" aria-label={label}>
      {source === 'Manual' && tier !== null
        ? <span aria-hidden="true" className="m-1 size-3 rotate-45 border-2 border-dashed" style={{ borderColor: `var(--rarity-${tier})` }} />
        : <Icon aria-hidden="true" size={20} style={{ color: tier === null ? 'var(--ink-3)' : `var(--rarity-${tier})` }} />}
      <span>{label}</span>
    </span>
  )
}
