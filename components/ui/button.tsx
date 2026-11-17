import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/components/utils'
import { Slot } from 'radix-ui'

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--radius-pill)] border-2 border-transparent text-[15px] font-sans font-extrabold whitespace-nowrap transition-opacity active:opacity-80 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground',
        outline: 'border-primary bg-transparent text-primary',
        ghost: 'bg-transparent text-foreground',
        publish: 'bg-info text-[var(--on-color)]',
        push: 'bg-destructive text-[var(--on-color)]',
      },
      size: {
        default: 'h-10 px-[18px] pt-[0.2em] [&_svg]:-mt-[0.2em]',
        sm: 'h-8 px-3 pt-[0.2em] text-[13px] [&_svg]:-mt-[0.2em]',
        icon: 'size-10 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
)

function Button({
  className,
  variant = 'primary',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
