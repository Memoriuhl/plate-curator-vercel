import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import { loadDashboard } from '@/lib/catalog/dashboard'
import { DashboardSkeleton } from '@/components/dashboard/skeleton'

async function FirstJurisdiction() {
  await connection()
  const { jurisdictions } = await loadDashboard()
  if (jurisdictions[0]) redirect(`/states/${jurisdictions[0].code}`)
  return <p>No jurisdictions available.</p>
}

export default function Home() {
  return (
    <main className="app-main">
      <Suspense fallback={<DashboardSkeleton kind="state" />}>
        <FirstJurisdiction />
      </Suspense>
    </main>
  )
}
