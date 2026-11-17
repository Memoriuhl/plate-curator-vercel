import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { batchBaselineScenarios } from './baseline-scenarios'

batchBaselineScenarios(async () => {
  const review = createMemoryStore([])
  return { review, jobs: createMemoryJobsStore(review, 'development') }
})
