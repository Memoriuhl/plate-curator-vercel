'use client'

import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { localPipelineReason } from '@/lib/local-pipeline'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/** Render a disabled pipeline action with the reason it is unavailable. */
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
            aria-label={`${label}: ${localPipelineReason('No action connected')}`}
            className="inline-flex"
          >
            <Button variant={variant} size={size} disabled>
              {children}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {localPipelineReason('No action connected')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
