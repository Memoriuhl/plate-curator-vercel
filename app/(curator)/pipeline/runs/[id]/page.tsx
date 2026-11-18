import { Suspense } from 'react'
import { PipelineRunResultsPage } from '@/components/dashboard/pipeline-run-results'

async function RunResults({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <PipelineRunResultsPage key={id} runId={id} />
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense
      fallback={
        <main className="p-4 md:p-6">
          <p role="status">Loading run results…</p>
        </main>
      }
    >
      <RunResults params={params} />
    </Suspense>
  )
}
