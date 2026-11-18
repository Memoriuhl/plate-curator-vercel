import { notFound } from 'next/navigation'
import { FamilyCard } from '@/components/plate/family-card'
import { PlateRow } from '@/components/plate/plate-row'
import { RarityMark } from '@/components/plate/rarity-mark'
import { plateCards } from '@/fixtures/plate-cards'

/** Render the plate component fixture gallery in development for visual inspection. */
export default function PlatesPreview() {
  if (process.env.NODE_ENV === 'production') notFound()
  return (
    <main className="grid gap-6 p-6">
      <h1 className="page-title">Shared plate components</h1>
      {(['light', 'dark'] as const).map(theme => (
        <section key={theme} data-theme={theme} className="grid gap-4 rounded-[var(--radius-lg)] bg-[var(--ground)] p-4 text-[var(--ink)]">
          <h2 className="section">{theme === 'light' ? 'Light' : 'Dark'}</h2>
          <div className="grid gap-4 xl:grid-cols-2">
            <FamilyCard template={plateCards[0]} variants={[]} groupingNote="A family of one." />
            <FamilyCard template={plateCards[1]} variants={plateCards.slice(2, 7)} groupingNote="One veterans base; branch emblems distinguish the variants." />
          </div>
          <div>{plateCards.map(plate => <PlateRow key={plate.id} plate={plate} />)}</div>
          <div className="flex flex-wrap gap-4">
            <RarityMark />
            <RarityMark tier={3} />
            <RarityMark tier={6} source="Observed" />
            <RarityMark tier={4} source="Manual" />
          </div>
        </section>
      ))}
    </main>
  )
}
