import { Suspense } from 'react'
import { StateContent } from '@/components/dashboard/dashboard-data'
import { DashboardSkeleton } from '@/components/dashboard/skeleton'

async function StatePageContent({
  params,
}: {
  params: Promise<{ code: string }>
}) {
  const { code } = await params
  return <StateContent code={code} />
}

export default function Dashboard({ params }: { params: Promise<{ code: string }> }) {
  return (
    <Suspense fallback={<DashboardSkeleton kind="state" />}>
      <StatePageContent params={params} />
    </Suspense>
  )
}
