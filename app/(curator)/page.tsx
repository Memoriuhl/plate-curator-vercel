import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import { loadDashboard } from '@/lib/catalog/dashboard'
import { batchHref } from '@/lib/review/href'
import { DashboardSkeleton } from '@/components/dashboard/skeleton'

type Search = Promise<{ batch?: string | string[] }>

/**
 * Redirect the curator home route to the first available jurisdiction once catalog data
 * loads.
 */
async function FirstJurisdiction({ searchParams }: { searchParams: Search }) {
  await connection()
  const [{ jurisdictions }, query] = await Promise.all([
    loadDashboard(),
    searchParams,
  ])
  const batch = Array.isArray(query.batch) ? query.batch[0] : query.batch
  if (jurisdictions[0])
    redirect(batchHref(`/states/${jurisdictions[0].code}`, batch ?? null))
  return <p>No jurisdictions available.</p>
}

/** Render the curator landing shell while the default jurisdiction is resolved. */
export default function Home({ searchParams }: { searchParams: Search }) {
  return (
    <main className="app-main">
      <Suspense fallback={<DashboardSkeleton kind="state" />}>
        <FirstJurisdiction searchParams={searchParams} />
      </Suspense>
    </main>
  )
}
