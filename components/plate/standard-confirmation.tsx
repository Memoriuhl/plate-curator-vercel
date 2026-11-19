'use client'

import { useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { StandardChange } from '@/lib/review/types'

type Plate = {
  id: string
  displayName: string
  state: string
  isStandard?: boolean
  deleted?: boolean
}
type Confirmation = { old?: Plate; next: Plate; resolve(value: boolean): void }

/** Request confirmation when an ordering change would switch a state's standard plate. */
export function useStandardConfirmation() {
  const restoreFocus = useRef<HTMLElement | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  /**
   * Identify the current and proposed standard and ask the curator to approve the
   * transition.
   */
  async function confirm(
    plates: readonly Plate[],
    to: string,
    firstChanged = false
  ): Promise<StandardChange | false | undefined> {
    const standards = plates.filter(
      (plate) => plate.isStandard && !plate.deleted
    )
    const old = standards.find((plate) => plate.id !== to) ?? standards[0]
    if (!firstChanged && standards.length === 1 && old?.id === to)
      return undefined
    const next = plates.find((plate) => plate.id === to)
    if (!next) return false
    restoreFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const accepted = await new Promise<boolean>((resolve) =>
      setConfirmation({ old, next, resolve })
    )
    return accepted ? { from: old?.id ?? null, to } : false
  }
  /** Resolve the pending standard decision, dismiss the prompt and restore focus. */
  function finish(value: boolean) {
    confirmation?.resolve(value)
    setConfirmation(null)
  }
  const alreadyStandard = confirmation?.old?.id === confirmation?.next.id
  const dialog = confirmation ? (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) finish(false)
      }}
    >
      <AlertDialogContent
        className="gap-[var(--stack-gap)]"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          restoreFocus.current?.focus()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {alreadyStandard
              ? `Move ${confirmation.next.displayName}, the ${confirmation.next.state} Standard, to first?`
              : `Make ${confirmation.next.displayName} the ${confirmation.next.state} Standard?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {alreadyStandard
              ? 'This moves the current Standard to the first position.'
              : confirmation.old
                ? `${confirmation.old.displayName} stops being the Standard.`
                : 'This state gains a Standard plate.'}{' '}
            The change is part of the draft until it&apos;s published.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => finish(false)}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => finish(true)}>
            {alreadyStandard ? 'Move to first' : 'Make Standard'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : null
  return { confirm, dialog, pending: confirmation !== null }
}
