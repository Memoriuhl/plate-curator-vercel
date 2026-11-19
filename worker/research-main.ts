import { runResearchWorkerOnce } from './research/research-run'
import { runLegacyResearch } from './research/research-legacy'

/**
 * Start the desktop research worker and poll for eligible jobs using its configured
 * credential.
 */
async function main() {
  const {
    API_BASE,
    RESEARCH_WORKER_TOKEN,
    RESEARCH_LEGACY_ROOT,
    VERCEL_PROTECTION_BYPASS,
    VERCEL_OIDC_TOKEN,
  } = process.env
  if (!API_BASE || !RESEARCH_WORKER_TOKEN || !RESEARCH_LEGACY_ROOT)
    throw new Error(
      'API_BASE, RESEARCH_WORKER_TOKEN and RESEARCH_LEGACY_ROOT are required'
    )
  /**
   * Wait between research worker polls when the service has no work or is unavailable.
   */
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms))
  while (true) {
    try {
      const outcome = await runResearchWorkerOnce({
        apiBase: API_BASE,
        token: RESEARCH_WORKER_TOKEN,
        protectionBypass: VERCEL_PROTECTION_BYPASS,
        trustedOidc: VERCEL_OIDC_TOKEN,
        fetch,
        heartbeatMs: 60000,
        sleep,
        /** Require the job's pinned legacy revision before running desktop research. */
        run: (job) => {
          if (!job.legacyRevision)
            throw new Error('Job has no frozen legacy revision')
          return runLegacyResearch(job.input, {
            legacyRoot: RESEARCH_LEGACY_ROOT,
            model: job.model,
            expectedRevision: job.legacyRevision,
          })
        },
      })
      if (outcome === 'stopped') return
      if (outcome === 'idle') await sleep(5000)
    } catch {
      console.error(
        'Research iteration failed; the claim will expire if not renewed'
      )
      await sleep(5000)
    }
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
