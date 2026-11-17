'use client'

import { Button } from '@/components/ui/button'
import { TagRunBanner } from './tag-run-banner'
import { useTagRun, type RunPlate } from './use-tag-run'

export function PlateTagActions({ plate }: { plate: RunPlate }) {
  const run = useTagRun()
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!!run.disabledReason || run.starting || run.entries.length > 0}
        title={run.disabledReason}
        onClick={() => void run.start([plate])}
      >
        Run Tag
      </Button>
      <TagRunBanner
        entries={run.entries}
        batchId={run.batchId}
        starting={run.starting}
        dismiss={run.dismiss}
        retry={(plate) => void run.start([plate], true)}
      />
    </>
  )
}
