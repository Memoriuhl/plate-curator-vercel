/**
 * Start the development usage counter when USAGE_COUNTER_FILE is set. Hosted deployments
 * and production builds skip it; see docs/live-updates.md.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { usageCounterFile } = await import('./lib/dev/usage-counter')
  const file = usageCounterFile()
  if (!file) return
  const { startUsageRecorder } = await import('./lib/dev/usage-recorder')
  startUsageRecorder(file)
}
