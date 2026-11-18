import { firestoreJobsStore } from '../jobs/firestore-store'
import { localJobsEnvironment, localPipelineScope } from '../jobs/local-scope'
import { researchDatabase, researchEnvironment } from './storage'

// Eve authored modules must not import the Next.js/Workflow server context.
// This reader shares the exact queue/review scopes without pulling its runtime.
/**
 * Build the queue store for hosted research using the matching local jobs and review
 * environments.
 */
export async function pipelineResearchStore() {
  const scope = localPipelineScope()
  if (!scope) throw Error('Pipeline research needs a dedicated local scope')
  return { scope, store: firestoreJobsStore(await researchDatabase(), localJobsEnvironment(scope), researchEnvironment()) }
}
