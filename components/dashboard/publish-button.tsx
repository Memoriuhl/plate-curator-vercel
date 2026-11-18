'use client'

import Link from 'next/link'
import { IoArrowUpOutline } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export function PublishButton({
  batchId,
  owner,
  approved,
  draft = false,
  size = 'default',
}: {
  batchId?: string
  owner: boolean
  approved: boolean
  draft?: boolean
  size?: 'default' | 'sm'
}) {
  const reason = !owner ? 'Only Owners can publish' : (!approved && !draft) || !batchId ? 'Approve the batch first' : null
  const content = [<IoArrowUpOutline key="icon" aria-hidden="true" />, 'Publish to players']
  if (!reason && batchId) {
    return <Button asChild variant="publish" size={size}><Link href={`/publish?batch=${encodeURIComponent(batchId)}`}>{content}</Link></Button>
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="publish"
            size={size}
            aria-disabled="true"
            aria-label={`Publish to players: ${reason}`}
            onClick={(event) => event.preventDefault()}
            className="cursor-not-allowed opacity-50"
          >{content}</Button>
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
