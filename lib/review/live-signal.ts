export function liveEnvKey(env: string): string {
  return encodeURIComponent(env)
}

export function signalPath(envKey: string, batchId: string): string {
  return `curatorLive/${envKey}/batchRevisions/${batchId}`
}
