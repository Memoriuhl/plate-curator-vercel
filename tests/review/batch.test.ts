import { createMemoryStore } from '../../lib/review/memory-store'
import { reviewBatchScenarios } from './batch-scenarios'

reviewBatchScenarios(batch => createMemoryStore([batch]))
