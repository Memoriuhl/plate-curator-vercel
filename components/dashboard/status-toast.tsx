'use client'

import { useEffect } from 'react'
import { IoCloseOutline } from 'react-icons/io5'

/** Announce an operation outcome and keep it visible at the bottom of the viewport. */
export function StatusToast({
  notice,
  onDismiss,
}: {
  notice: { message: string } | null
  onDismiss(): void
}) {
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(onDismiss, 6000)
    return () => clearTimeout(timer)
  }, [notice, onDismiss])
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2">
      <div
        className={
          notice
            ? 'pointer-events-auto flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--hairline)] bg-popover py-2 pr-2 pl-3 text-sm text-popover-foreground shadow-xl'
            : undefined
        }
      >
        <div role="status" aria-atomic="true">
          {notice?.message}
        </div>
        {notice ? (
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={onDismiss}
            className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-md)] hover:bg-accent focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
          >
            <IoCloseOutline aria-hidden size={18} />
          </button>
        ) : null}
      </div>
    </div>
  )
}
