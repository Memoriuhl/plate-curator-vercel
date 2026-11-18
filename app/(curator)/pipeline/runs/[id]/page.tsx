import { Suspense } from 'react'
import { PipelineRunResultsPage } from '@/components/dashboard/pipeline-run-results'
import { PipelineResultsSkeleton } from '@/components/dashboard/pipeline-results-skeleton'
import styles from '@/components/dashboard/pipeline-results.module.css'

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
        <main className={styles.page}>
          <PipelineResultsSkeleton header />
        </main>
      }
    >
      <RunResults {...props} />
    </Suspense>
  )
}
