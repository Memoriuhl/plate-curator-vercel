'use client'

import { TaggingModelPicker, useTaggingModelChoice } from './tagging-model-picker'
import { Button } from '@/components/ui/button'
import { TagRunBanner } from './tag-run-banner'
import { useTagRun, type RunPlate } from './use-tag-run'

/** Connect a single plate's pipeline menu to the selected tagging model and run state. */
export function PlateTagActions({ plate }: { plate: RunPlate }) {
  const choice = useTaggingModelChoice()
  const run = useTagRun()
  return (
    <>
      <TaggingModelPicker choice={choice} error={run.modelError} />
      <Button
        size="sm"
        variant="outline"
        disabled={!!run.disabledReason || run.starting || run.entries.length > 0}
        title={run.disabledReason}
        onClick={() => void run.start([plate], false, choice.modelId)}
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
