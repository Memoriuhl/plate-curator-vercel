'use client'

import type { ComponentProps, ReactNode } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

// Adapted from the AI Elements model-selector registry component.
export const ModelSelector = Dialog
export const ModelSelectorTrigger = DialogTrigger
export const ModelSelectorInput = CommandInput
export const ModelSelectorList = CommandList
export const ModelSelectorEmpty = CommandEmpty
export const ModelSelectorGroup = CommandGroup
export const ModelSelectorItem = CommandItem

export function ModelSelectorContent({
  children,
  title,
  controls,
  ...props
}: Omit<ComponentProps<typeof DialogContent>, 'title'> & {
  title: string
  controls?: ReactNode
}) {
  return (
    <DialogContent aria-describedby={undefined} {...props}>
      <DialogTitle className="pr-9 text-lg font-bold">{title}</DialogTitle>
      {controls}
      <Command label="Search models" shouldFilter={false}>
        {children}
      </Command>
    </DialogContent>
  )
}
