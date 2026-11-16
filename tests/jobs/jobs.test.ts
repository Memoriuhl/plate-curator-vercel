import { jobsScenarios } from './scenarios'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'

jobsScenarios(async () => {
  const review = createMemoryStore([])
  const store = createMemoryJobsStore(review, 'development')
  return { review, store, other: store.forEnvironment('production') }
})
