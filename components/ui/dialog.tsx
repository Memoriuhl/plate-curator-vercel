'use client'

import type { ComponentProps } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { IoCloseOutline } from 'react-icons/io5'
import { cn } from '@/components/utils'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogTitle = DialogPrimitive.Title

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-black/50" />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-[101] grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-1/2 gap-[var(--stack-gap)] overflow-auto rounded-[var(--radius-xl)] bg-[var(--card)] p-4 text-foreground shadow-pop outline-none sm:p-6',
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute top-4 right-4 grid size-8 place-items-center rounded-full hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary">
          <IoCloseOutline className="chrome-icon" aria-hidden="true" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}
