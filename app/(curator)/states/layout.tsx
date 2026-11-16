import { Suspense } from 'react'
import { JurisdictionStrip } from '@/components/dashboard/dashboard-data'
import { DashboardSearch } from '@/components/dashboard/search'
import { ReviewStrip } from '@/components/dashboard/review-strip'
import { DashboardSkeleton } from '@/components/dashboard/skeleton'

export default function StatesLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-main dashboard group/states">
      <Suspense fallback={<div role="status">Loading review batches…</div>}>
        <ReviewStrip />
      </Suspense>
      <Suspense fallback={<div className="dashboard-search" role="status">Loading search…</div>}>
        <DashboardSearch />
      </Suspense>
      <Suspense fallback={<DashboardSkeleton kind="jurisdictions" />}>
        <JurisdictionStrip />
      </Suspense>
      <Suspense fallback={<DashboardSkeleton kind="state" />}>
        <div className="transition-opacity group-has-[[data-navigation-pending]]/states:opacity-70">
          {children}
        </div>
      </Suspense>
    </main>
  )
}
