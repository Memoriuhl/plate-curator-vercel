'use client'

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/components/utils'
import { Tabs as TabsPrimitive } from 'radix-ui'

/** Provide the shared Radix tabs root with the requested orientation and layout. */
function Tabs({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        'group/tabs flex gap-2 data-horizontal:flex-col',
        className,
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  'inline-flex w-fit items-center justify-center gap-1 rounded-[var(--radius-pill)] bg-muted p-1',
  {
    variants: { variant: { default: '', line: 'bg-transparent' } },
    defaultVariants: { variant: 'default' },
  },
)

/** Render the tab controls with the chosen shared visual treatment. */
function TabsList({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

/** Display a selectable tab with focus and active-state styles. */
function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex h-[34px] items-center justify-center gap-2 rounded-[var(--radius-pill)] px-[18px] text-sm font-extrabold whitespace-nowrap text-foreground active:opacity-80 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

/** Render the active tab's associated content panel. */
function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 text-sm outline-none', className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
