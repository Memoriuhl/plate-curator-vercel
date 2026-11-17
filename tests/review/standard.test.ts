import { createMemoryStore } from '../../lib/review/memory-store'
import { standardScenarios } from './standard-scenarios'
standardScenarios(batch => createMemoryStore([batch]))
