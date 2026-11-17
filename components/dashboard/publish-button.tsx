'use client'

import Link from 'next/link'
import { IoArrowUpOutline } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export function PublishButton({
  owner,
  approved,
  size = 'default',
}: {
  owner: boolean
  approved: boolean
  size?: 'default' | 'sm'
}) {
  const reason = !owner ? 'Only Owners can publish' : !approved ? 'Approve the batch first' : null
  const content = [<IoArrowUpOutline key="icon" aria-hidden="true" />, 'Publish to players']
  if (!reason) {
    return <Button asChild variant="publish" size={size}><Link href="/publish">{content}</Link></Button>
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-label={`Publish to players: ${reason}`} className="inline-flex">
            <Button variant="publish" size={size} disabled>{content}</Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
