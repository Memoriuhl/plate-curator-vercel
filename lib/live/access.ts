import { liveEnvKey } from '../review/signals/live-signal'

export type LiveAccessDeps = {
  env: string
  now(): Date
  write(uid: string, envKey: string, expiresAt: Date): Promise<void>
}

/**
 * Grant the signed-in user a short-lived subscription in the current review environment.
 */
export async function grantLiveAccess(
  deps: LiveAccessDeps,
  uid: string
): Promise<{ envKey: string; expiresAt: string }> {
  const envKey = liveEnvKey(deps.env)
  const expiresAt = new Date(deps.now().getTime() + 60 * 60_000)
  await deps.write(uid, envKey, expiresAt)
  return { envKey, expiresAt: expiresAt.toISOString() }
}
