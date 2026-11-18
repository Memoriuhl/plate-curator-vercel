/** Encode the review environment as one safe Firestore path segment. */
export function liveEnvKey(env: string): string {
  return encodeURIComponent(env)
}

/** Locate the batch revision document shared by writers and live subscribers. */
export function signalPath(envKey: string, batchId: string): string {
  return `curatorLive/${envKey}/batchRevisions/${batchId}`
}
