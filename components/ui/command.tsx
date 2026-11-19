'use client'

import type { ComponentProps } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { IoSearchOutline } from 'react-icons/io5'
import { cn } from '@/components/utils'

export function Command({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn('grid min-w-0 gap-2', className)}
      {...props}
    />
  )
}

export function CommandInput({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2 rounded-full bg-muted px-3 focus-within:outline-2 focus-within:outline-primary">
      <IoSearchOutline className="chrome-icon shrink-0" aria-hidden="true" />
      <CommandPrimitive.Input
        className={cn(
          'h-9 min-w-0 flex-1 bg-transparent text-sm outline-none',
          className
        )}
        {...props}
      />
    </div>
  )
}

export function CommandList(
  props: ComponentProps<typeof CommandPrimitive.List>
) {
  return (
    <CommandPrimitive.List
      className="max-h-[min(20rem,50dvh)] overflow-y-auto overscroll-contain"
      {...props}
    />
  )
}

export function CommandEmpty(
  props: ComponentProps<typeof CommandPrimitive.Empty>
) {
  return <CommandPrimitive.Empty className="caption px-2 py-3" {...props} />
}

export function CommandGroup(
  props: ComponentProps<typeof CommandPrimitive.Group>
) {
  return (
    <CommandPrimitive.Group
      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-bold"
      {...props}
    />
  )
}

export function CommandItem(
  props: ComponentProps<typeof CommandPrimitive.Item>
) {
  return (
    <CommandPrimitive.Item
      className="flex cursor-pointer items-center justify-between gap-3 rounded-[var(--radius)] p-2 text-sm data-[selected=true]:bg-muted data-[selected=true]:outline-1 data-[selected=true]:-outline-offset-1 data-[selected=true]:outline-primary"
      {...props}
    />
  )
}
