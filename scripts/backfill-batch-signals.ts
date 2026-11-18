import { loadEnvConfig } from '@next/env'
import { backfillBatchSignals } from '../lib/review/backfill-signals'
import { assertStagingProject } from '../lib/review/demo-seed'
import { firestoreBatchSignalsBackfillStore } from '../lib/review/firestore-backfill-signals'

/**
 * Load staging configuration and run the missing revision signal backfill for the
 * selected review environment.
 */
async function main() {
  loadEnvConfig(process.cwd())
  assertStagingProject(process.env.GCP_PROJECT_ID)
  const { stagingFirestore } = await import('../lib/gcp/firestore')
  const { reviewEnv } = await import('../lib/server/context')
  console.log(
    JSON.stringify(
      await backfillBatchSignals(
        firestoreBatchSignalsBackfillStore(stagingFirestore()),
        {
          projectId: process.env.GCP_PROJECT_ID,
          env: reviewEnv(),
        }
      )
    )
  )
}

main().catch(() => {
  console.error('Batch signal backfill failed; verify staging configuration')
  process.exitCode = 1
})
