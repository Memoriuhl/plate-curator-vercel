'use client'

import { useRef, useState } from 'react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import type { StandardChange } from '@/lib/review/types'

type Plate = { id: string; displayName: string; state: string; isStandard?: boolean; deleted?: boolean }
type Confirmation = { old: string; next: Plate; resolve(value: boolean): void }

export function useStandardConfirmation() {
  const restoreFocus = useRef<HTMLElement | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  async function confirm(plates: readonly Plate[], to: string): Promise<StandardChange | false | undefined> {
    const old = plates.find(plate => plate.isStandard && !plate.deleted)
    if (old?.id === to) return undefined
    const next = plates.find(plate => plate.id === to)
    if (!next) return false
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const accepted = await new Promise<boolean>(resolve => setConfirmation({ old: old?.displayName ?? 'No plate', next, resolve }))
    return accepted ? { from: old?.id ?? null, to } : false
  }
  function finish(value: boolean) {
    confirmation?.resolve(value)
    setConfirmation(null)
  }
  const dialog = confirmation ? <AlertDialog open onOpenChange={open => { if (!open) finish(false) }}>
    <AlertDialogContent className="gap-[var(--stack-gap)]" onCloseAutoFocus={event => { event.preventDefault(); restoreFocus.current?.focus() }}>
      <AlertDialogHeader>
        <AlertDialogTitle>Make {confirmation.next.displayName} the {confirmation.next.state} Standard?</AlertDialogTitle>
        <AlertDialogDescription>{confirmation.old} stops being the Standard. This is part of your Batch until it&apos;s published.</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel onClick={() => finish(false)}>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={() => finish(true)}>Make Standard</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog> : null
  return { confirm, dialog, pending: confirmation !== null }
}
