import { createMemoryStore } from '../../lib/review/memory-store'
import { sharedDraftScenarios } from './draft-scenarios'

sharedDraftScenarios(() => createMemoryStore([]))
