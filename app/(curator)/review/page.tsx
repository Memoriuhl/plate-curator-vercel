import { Suspense } from 'react'
import { connection } from 'next/server'
import { loadDashboard, loadJurisdiction } from '@/lib/catalog/dashboard'
import { ReviewWorkspace } from '@/components/review/workspace'

type Search = Promise<{ state?: string }>

/** Load jurisdiction data and search parameters needed to render the review workspace. */
async function ReviewData({ searchParams }: { searchParams: Search }) {
  await connection()
  const [{ jurisdictions }, query] = await Promise.all([
    loadDashboard(),
    searchParams,
  ])
  const data = query.state ? await loadJurisdiction(query.state) : null
  const states = jurisdictions.map((state) => {
    return {
      code: state.code,
      name: state.name,
      plateCount: state.plateCount,
      plates: (data?.code === state.code ? data.plates : []).map(
        ({ id, displayName, imageUrl }) => ({
          id,
          displayName,
          imageUrl,
        }),
      ),
    }
  })
  return <ReviewWorkspace states={states} />
}

/**
 * Render the review route with a loading fallback while it resolves the workspace data.
 */
export default function ReviewPage({ searchParams }: { searchParams: Search }) {
  return (
    <main className="p-4 md:p-6">
      <Suspense
        fallback={
          <div
            className="grid min-h-[calc(100dvh-var(--header-h)-var(--space-6)*2)] grid-cols-1 gap-4 md:grid-cols-[200px_290px_1fr]"
            aria-label="Loading review"
          >
            <div className="animate-pulse rounded-3xl bg-card" />
            <div className="hidden animate-pulse rounded-3xl bg-card md:block" />
            <div className="hidden animate-pulse rounded-3xl bg-card md:block" />
          </div>
        }
      >
        <ReviewData searchParams={searchParams} />
      </Suspense>
    </main>
  )
}
