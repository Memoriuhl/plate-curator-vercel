'use client'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  plateSelection,
  useHiddenSelectionCount,
  useSelectedPlates,
} from './plate-selection'
import { useSelectionAction } from './selection-actions'

/**
 * Show selection counts by jurisdiction and hold the actions for the selection: run the
 * pipeline, make Templates and clear.
 */
export function SelectionBar() {
  const plates = useSelectedPlates()
  const hiddenCount = useHiddenSelectionCount()
  const promote = useSelectionAction('promote')
  const runPipeline = useSelectionAction('runPipeline')
  if (!plates.length) return null
  const states = Map.groupBy(plates, (plate) => plate.state)
  return (
    <div
      data-selection-controls
      aria-label="Plate selection"
      className="selection-bar fixed bottom-4 left-1/2 z-40 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-[var(--radius-lg)] p-2 shadow-xl"
    >
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">
            {plates.length} selected
            {hiddenCount > 0 ? `, ${hiddenCount} hidden by filter` : ''}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Selected plates"
          className="max-h-80 overflow-auto"
        >
          {[...states].map(([state, group]) => (
            <section
              key={state}
              className="mb-2 rounded-sm border border-[var(--hairline)] p-2"
            >
              <h3>
                {state} ({group.length})
              </h3>
              {group.map((plate) => (
                <p key={plate.id}>{plate.displayName}</p>
              ))}
            </section>
          ))}
        </PopoverContent>
      </Popover>
      {runPipeline ? (
        <Button
          disabled={runPipeline.disabled}
          onClick={() => void runPipeline.run()}
        >
          Run pipeline on {plates.length}{' '}
          {plates.length === 1 ? 'plate' : 'plates'}
        </Button>
      ) : null}
      {promote ? (
        <Button
          variant="outline"
          disabled={promote.disabled}
          onClick={() => void promote.run()}
        >
          Make Templates
        </Button>
      ) : null}
      <Button variant="ghost" onClick={() => plateSelection.clear()}>
        Clear
      </Button>
    </div>
  )
}
