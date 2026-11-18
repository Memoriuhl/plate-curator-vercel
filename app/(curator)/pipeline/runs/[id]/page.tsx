import { Suspense } from 'react'
import { PipelineRunResultsPage } from '@/components/dashboard/pipeline-run-results'

type PageProps = {
  params: Promise<{ id: string }>
  searchParams: Promise<{ stage?: string | string[] }>
}

async function RunResults({ params, searchParams }: PageProps) {
  const [{ id }, { stage }] = await Promise.all([params, searchParams])
  return (
    <PipelineRunResultsPage
      key={id}
      runId={id}
      stage={typeof stage === 'string' ? stage : undefined}
    />
  )
}

export default function Page(props: PageProps) {
  return (
    <Suspense
      fallback={
        <main className="p-4 md:p-6">
          <p role="status">Loading run results…</p>
        </main>
      }
    >
      <RunResults {...props} />
    </Suspense>
  )
}
