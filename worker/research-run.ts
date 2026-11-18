import type { ResearchJob, ResearchResult } from '../lib/research/types'

type Deps = { apiBase: string; token: string; fetch: typeof fetch; run(job: ResearchJob): Promise<ResearchResult>; heartbeatMs: number; sleep(ms: number): Promise<void>; protectionBypass?: string; trustedOidc?: string }
/**
 * Claim one desktop research job, renew its lease during execution and report the result
 * under its claim.
 */
export async function runResearchWorkerOnce(deps: Deps): Promise<'idle' | 'stopped' | 'reported' | 'dropped'> {
  const headers = { Authorization: `Bearer ${deps.token}`, ...(deps.trustedOidc ? { 'x-vercel-trusted-oidc-idp-token': deps.trustedOidc } : {}), ...(deps.protectionBypass ? { 'x-vercel-protection-bypass': deps.protectionBypass } : {}) }
  const base = deps.apiBase.replace(/\/+$/, '')
  const response = await deps.fetch(`${base}/api/research-worker/claim`, { method: 'POST', headers, signal: AbortSignal.timeout(15000) })
  if (response.status === 401) return 'stopped'
  if (response.status === 204) return 'idle'
  if (!response.ok) throw new Error(`Research claim failed: ${response.status}`)
  const claim = await response.json() as { job: ResearchJob; claimId: string; leaseExpiresAt: number }
  const reportUrl = `${base}/api/research-worker/jobs/${encodeURIComponent(claim.job.id)}`
  let lost = false
  let stopped = false
  let heartbeatRunning = false
  const heartbeat = setInterval(() => {
    if (heartbeatRunning) return
    heartbeatRunning = true
    void deps.fetch(`${reportUrl}/heartbeat`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ claimId: claim.claimId }), signal: AbortSignal.timeout(15000) }).then(async response => {
      if (response.status === 401) { lost = true; stopped = true }
      else if (response.ok) { const value = await response.json(); claim.leaseExpiresAt = value.value.leaseExpiresAt }
      else if (response.status < 500) lost = true
    }).catch(() => undefined).finally(() => { heartbeatRunning = false })
  }, deps.heartbeatMs)
  heartbeat.unref()
  try {
    const result = await deps.run(claim.job)
    if (lost) return stopped ? 'stopped' : 'dropped'
    for (let attempt = 0; attempt < 4; attempt++) {
      if (Date.now() >= claim.leaseExpiresAt || lost) return stopped ? 'stopped' : 'dropped'
      try {
        const report = await deps.fetch(`${reportUrl}/report`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ claimId: claim.claimId, result }), signal: AbortSignal.timeout(15000) })
        if (report.status === 401) return 'stopped'
        if (report.ok) return 'reported'
        if (report.status < 500) return 'dropped'
      } catch { }
      await deps.sleep(500 * 2 ** attempt)
    }
    return 'dropped'
  } finally { clearInterval(heartbeat) }
}
