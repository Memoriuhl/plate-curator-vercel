import type { ModelAdapter } from './model'

export interface WorkerDeps {
  apiBase: string
  token: string
  protectionBypass?: string
  fetch: typeof fetch
  adapter: ModelAdapter
  readImage: (image: string) => Promise<string>
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (event: string) => void
}
type Outcome = 'idle' | 'reported' | 'dropped' | 'stopped'
interface Claim {
  job: { id: string }
  claimId: string
  leaseExpiresAt: string
  plate: { image: string; displayName: string; state: string; tags: string[] }
}

export async function runOnce(deps: WorkerDeps): Promise<Outcome> {
  const headers: Record<string, string> = { Authorization: `Bearer ${deps.token}` }
  if (deps.protectionBypass) headers['x-vercel-protection-bypass'] = deps.protectionBypass
  const base = deps.apiBase.replace(/\/+$/, '')
  const response = await deps.fetch(`${base}/api/worker/claim`, { method: 'POST', headers })
  if (response.status === 401) return 'stopped'
  if (response.status === 204) return 'idle'
  if (!response.ok) throw new Error(`Claim failed: ${response.status}`)
  const claim = await response.json() as Claim
  const deadline = Date.parse(claim.leaseExpiresAt)
  const start = deps.now()
  let backend = deps.adapter.backend
  let suggestions: string[] = []
  let usage: Record<string, number> | undefined
  let imageB64: string
  try {
    imageB64 = await deps.readImage(claim.plate.image)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    backend = 'missing-image'
    imageB64 = ''
  }
  if (backend !== 'missing-image') {
    const result = await deps.adapter.suggest({ imageB64, plate: claim.plate })
    suggestions = result.tags
    usage = result.usage
  }
  const body = JSON.stringify({ claimId: claim.claimId, suggestions, backend, model: deps.adapter.model, promptVersion: deps.adapter.promptVersion, durationMs: Math.max(0, deps.now() - start), ...(usage ? { usage } : {}) })
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (!Number.isFinite(deadline) || deps.now() >= deadline) break
    try {
      const report = await deps.fetch(`${base}/api/worker/jobs/${encodeURIComponent(claim.job.id)}/report`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(Math.max(1, deadline - deps.now())) })
      if (report.status === 401) return 'stopped'
      if (report.ok) return 'reported'
      if (report.status === 409) {
        const detail = await report.json().catch(() => ({}))
        deps.log(`Report conflict: ${detail.error ?? 'unknown'}`)
        return 'dropped'
      }
      if (report.status < 500) {
        deps.log(`Report rejected: ${report.status}`)
        return 'dropped'
      }
      deps.log(`Report failed: ${report.status}`)
    } catch {
      deps.log('Report network failure')
    }
    const delay = 500 * 2 ** attempt
    if (attempt === 3 || deps.now() + delay >= deadline) break
    await deps.sleep(delay)
  }
  deps.log('Report abandoned')
  return 'dropped'
}

export async function runLoop(deps: WorkerDeps, { idleMs }: { idleMs: number }): Promise<void> {
  for (;;) {
    try {
      const outcome = await runOnce(deps)
      if (outcome === 'stopped') return
      if (outcome === 'idle') await deps.sleep(idleMs)
    } catch {
      deps.log('Worker iteration failed')
      await deps.sleep(idleMs)
    }
  }
}
