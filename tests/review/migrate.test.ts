import { createMemoryStore } from '../../lib/review/memory-store'
import { migrationScenarios } from './migrate-scenarios'

migrationScenarios(() => createMemoryStore([]))
