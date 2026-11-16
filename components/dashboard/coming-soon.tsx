'use client'

import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export function ComingSoon({
  children,
  label,
  variant = 'primary',
  size = 'default',
}: {
  children: ReactNode
  label: string
  variant?: 'primary' | 'publish'
  size?: 'default' | 'sm'
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            aria-label={`${label}: Coming soon`}
            className="inline-flex"
          >
            <Button variant={variant} size={size} disabled>
              {children}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Coming soon</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
