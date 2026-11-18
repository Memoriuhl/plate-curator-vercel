import {
  DashboardPipelineProvider,
  DashboardPipelineRail,
} from '@/components/dashboard/pipeline-runs'
import { SelectedBatchBar } from '@/components/dashboard/selected-batch-bar'
import { Suspense } from 'react'
import { JurisdictionStrip } from '@/components/dashboard/dashboard-data'
import { DashboardSearch } from '@/components/dashboard/search'
import { ReviewStrip } from '@/components/dashboard/review-strip'
import { DashboardSkeleton } from '@/components/dashboard/skeleton'

/**
 * Render the shared jurisdiction navigation and active state content within a loading
 * boundary.
 */
export default function StatesLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <Suspense
      fallback={
        <main className="app-main">
          <DashboardSkeleton kind="state" />
        </main>
      }
    >
      <DashboardPipelineProvider>
        <main className="app-main dashboard states-layout group/states">
          <div className="states-review">
            <Suspense
              fallback={
                <div
                  className="review-loading flex h-11 items-center"
                  role="status"
                >
                  Loading review batches…
                </div>
              }
            >
              <ReviewStrip />
              <SelectedBatchBar />
            </Suspense>
          </div>
          <Suspense fallback={<DashboardSkeleton kind="jurisdictions" />}>
            <JurisdictionStrip />
          </Suspense>
          <Suspense
            fallback={
              <div className="dashboard-search" role="status">
                Loading search…
              </div>
            }
          >
            <DashboardSearch />
          </Suspense>
          <DashboardPipelineRail />
          <Suspense fallback={<DashboardSkeleton kind="state" />}>
            <div className="states-content transition-opacity group-has-[[data-navigation-pending]]/states:opacity-70">
              {children}
            </div>
          </Suspense>
        </main>
      </DashboardPipelineProvider>
    </Suspense>
  )
}
