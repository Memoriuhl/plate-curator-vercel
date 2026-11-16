import { Suspense } from 'react'
import {
  JurisdictionStrip,
  StateContent,
} from '@/components/dashboard/dashboard-data'
import { DashboardSearch } from '@/components/dashboard/search'
import { ReviewStrip } from '@/components/dashboard/review-strip'
import { DashboardSkeleton } from '@/components/dashboard/skeleton'

async function Jurisdictions({
  params,
}: {
  params: Promise<{ code: string }>
}) {
  const { code } = await params
  return <JurisdictionStrip code={code} />
}

async function State({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  return <StateContent code={code} />
}

export default function Dashboard({
  params,
}: {
  params: Promise<{ code: string }>
}) {
  return (
    <main className="app-main dashboard">
      <ReviewStrip />
      <Suspense
        fallback={
          <div className="dashboard-search" role="status">
            Loading search…
          </div>
        }
      >
        <DashboardSearch />
      </Suspense>
      <Suspense fallback={<DashboardSkeleton kind="jurisdictions" />}>
        <Jurisdictions params={params} />
      </Suspense>
      <Suspense fallback={<DashboardSkeleton kind="state" />}>
        <State params={params} />
      </Suspense>
    </main>
  )
}
