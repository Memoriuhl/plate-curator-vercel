import { Suspense } from 'react'
import { PipelineQueueWarmup } from '@/components/dashboard/use-pipeline-queue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CuratorHeader } from '../../components/app/curator-header'
import { SessionGate } from '../../components/app/session-gate'

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
      <SessionGate>{children}</SessionGate>
    </TooltipProvider>
  )
}
