import { PipelineQueueWarmup } from '@/components/dashboard/use-pipeline-queue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CuratorHeader } from '../../components/app/curator-header'
import { SessionGate } from '../../components/app/session-gate'

export default function CuratorLayout({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={300}>
      <CuratorHeader />
      <PipelineQueueWarmup />
      <SessionGate>{children}</SessionGate>
    </TooltipProvider>
  )
}
