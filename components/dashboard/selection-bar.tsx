'use client'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { plateSelection, useSelectedPlates } from './plate-selection'

export function SelectionBar({ promote, disabled }: { promote(): Promise<void>; disabled: boolean }) {
  const plates = useSelectedPlates()
  if (!plates.length) return null
  const states = Map.groupBy(plates, plate => plate.state)
  return <div aria-label="Plate selection" className="mb-4 flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] bg-[var(--card)] p-3">
    <Popover><PopoverTrigger asChild><Button variant="outline">{plates.length} selected</Button></PopoverTrigger>
      <PopoverContent aria-label="Selected plates" className="max-h-80 overflow-auto">
        {[...states].map(([state, group]) => <section key={state} className="mb-2 rounded-sm border border-[var(--hairline)] p-2"><h3>{state} ({group.length})</h3>{group.map(plate => <p key={plate.id}>{plate.displayName}</p>)}</section>)}
      </PopoverContent>
    </Popover>
    <Button variant="ghost" onClick={() => plateSelection.clear()}>Clear</Button>
    <Button variant="outline" disabled={disabled || !plates.some(plate => plate.templateRole === 'variant')} onClick={() => void promote()}>Promote to Template</Button>
    <Button variant="outline" onClick={() => document.querySelector<HTMLButtonElement>('[data-run-trigger]')?.click()}>Run pipeline on selection</Button>
  </div>
}
