'use client'

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/components/utils'
import { Toggle as TogglePrimitive } from 'radix-ui'

const toggleVariants = cva(
  'inline-flex items-center justify-center gap-2 [text-box:trim-both_cap_alphabetic] rounded-[var(--radius-pill)] text-[13px] font-extrabold text-foreground active:opacity-80 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: { default: 'bg-card', inset: 'bg-muted' },
      size: { default: 'h-8 px-3', sm: 'h-8 px-3', lg: 'h-10 px-4' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

function Toggle({
  className,
  variant,
  size,
  count,
  children,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants> & { count?: number }) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size }), 'leading-none', className)}
      {...props}
    >
      {children}
      {count !== undefined ? <span className="count">{count}</span> : null}
    </TogglePrimitive.Root>
  )
}

export { Toggle, toggleVariants }
