import { Suspense } from 'react'
import { loadDashboard } from '@/lib/catalog/dashboard'
import {
  JurisdictionStrip,
  StateContent,
  FamilyGridSlot,
} from '@/components/dashboard/dashboard-data'
import { DashboardSearch } from '@/components/dashboard/search'
import { ReviewStrip } from '@/components/dashboard/review-strip'
import { DashboardSkeleton } from '@/components/dashboard/skeleton'

export async function generateStaticParams() {
  const { jurisdictions } = await loadDashboard()
  return jurisdictions.map(({ code }) => ({ code }))
}

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
      <FamilyGridSlot />
    </main>
  )
}
