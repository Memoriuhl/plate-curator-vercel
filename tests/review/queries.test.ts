import { createMemoryStore } from '../../lib/review/memory-store'
import { reviewQueryScenarios } from './query-scenarios'

reviewQueryScenarios(() => createMemoryStore([]))
