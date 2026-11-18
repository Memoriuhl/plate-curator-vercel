import type { Environment } from './types'

/**
 * Read and validate the local pipeline scope used to isolate a preview worker's records.
 */
export function localPipelineScope(): string | undefined {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1') return undefined
  const scope = process.env.LOCAL_PIPELINE_SCOPE
  if (!scope || !/^[a-zA-Z0-9_-]{1,80}$/.test(scope)) throw new Error('Local pipeline needs a dedicated LOCAL_PIPELINE_SCOPE')
  return scope
}

/** Derive the jobs environment that isolates the queue for this local pipeline scope. */
export function localJobsEnvironment(scope: string): Environment {
  return `preview:local-pipeline-${scope}`
}
