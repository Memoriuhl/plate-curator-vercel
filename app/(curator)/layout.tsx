import { Suspense } from 'react'
import { PipelineQueueWarmup } from '@/components/dashboard/pipeline-runs/use-pipeline-queue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CuratorHeader } from '../../components/app/curator-header'
import { SessionGate } from '../../components/app/session-gate'
import { LegacyBatchLink } from '../../components/review/legacy-batch-link'

/** Provide shared tooltips and enforce sign-in for routes in the curator workspace. */
export default function CuratorLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <CuratorHeader />
      <Suspense fallback={null}>
        <PipelineQueueWarmup />
      </Suspense>
      <SessionGate>
        <Suspense fallback={null}>
          <LegacyBatchLink />
        </Suspense>
        {children}
      </SessionGate>
    </TooltipProvider>
  )
}
