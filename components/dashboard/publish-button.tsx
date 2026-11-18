'use client'

import Link from 'next/link'
import { IoArrowUpOutline } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import { batchHref } from '@/lib/review/href'

export function PublishButton({ batchId, owner, size = 'default' }: {
  batchId?: string
  owner: boolean
  size?: 'default' | 'sm'
}) {
  if (!owner || batchId === undefined) return null
  return (
    <Button asChild variant="publish" size={size}>
      <Link href={batchHref('/publish', batchId)}>
        <IoArrowUpOutline aria-hidden="true" />
        Publish
      </Link>
    </Button>
  )
}
