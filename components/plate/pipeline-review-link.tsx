import Link from 'next/link'
import { Button } from '@/components/ui/button'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import { reviewHref } from '@/lib/review/href'

export function PipelineReviewLink({ plate }: { plate: PlateCardData }) {
  if (!plate.pipelineBatchId) return null
  return (
    <Button
      asChild
      variant="publish"
      size="sm"
      className="h-6 px-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/plate:opacity-100 [@media(hover:hover)]:group-focus-within/plate:opacity-100"
    >
      <Link
        aria-label={`Review ${plate.displayName}`}
        data-pipeline-review
        href={reviewHref(plate.state, plate.id, plate.pipelineBatchId)}
        prefetch={false}
      >
        Review
      </Link>
    </Button>
  )
}
