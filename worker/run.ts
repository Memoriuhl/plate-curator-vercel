import type { ModelAdapter } from './model'
import type { FieldSuggestion, PipelineStage, StageError } from '../lib/jobs/types'
import type { GroupInput } from '../lib/jobs/specialized-suggestions'
import type { ImageGroupOptions } from '../lib/jobs/image-options'
import type { LocalWorkerCapabilities } from '../lib/jobs/capabilities'
import { localCapabilityReport, withCapabilityHeartbeat } from './capability-heartbeat'

export type WorkerPlate = { image: string; imageUrl?: string | null; displayName: string; state: string; tags: string[]; description?: string | null; sourceUrl?: string | null; wikiUrl?: string | null }
export type StageResult = { fieldSuggestion?: FieldSuggestion; stageError?: StageError; backend: string; model: string; promptVersion: string; usage?: Record<string, number> }

export interface WorkerDeps {
  capabilities?: LocalWorkerCapabilities
  apiBase: string
  token: string
  protectionBypass?: string
  fetch: typeof fetch
  adapter: ModelAdapter
  adapterFor?: (model: string) => ModelAdapter
  suggestFields?: (input: { stage: PipelineStage; plate: WorkerPlate; model?: string; groupScope?: GroupInput; standardId?: string; options?: ImageGroupOptions }) => Promise<StageResult>
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
  model?: string
  stage?: PipelineStage
  groupScope?: GroupInput
  standardId?: string
  stageOptions?: ImageGroupOptions
  plate: WorkerPlate
}

export async function runOnce(deps: WorkerDeps): Promise<Outcome> {
  const headers: Record<string, string> = { Authorization: `Bearer ${deps.token}` }
  if (deps.protectionBypass) headers['x-vercel-protection-bypass'] = deps.protectionBypass
  const base = deps.apiBase.replace(/\/+$/, '')
  const capabilities = localCapabilityReport(deps)
  const response = await deps.fetch(`${base}/api/worker/claim`, { method: 'POST', headers: capabilities ? { ...headers, 'Content-Type': 'application/json' } : headers, ...(capabilities ? { body: JSON.stringify({ capabilities }) } : {}) })
  if (response.status === 401) return 'stopped'
  if (response.status === 204) return 'idle'
  if (!response.ok) throw new Error(`Claim failed: ${response.status}`)
  const claim = await response.json() as Claim
  return withCapabilityHeartbeat(deps, () => executeClaim(deps, claim, headers, base))
}

async function executeClaim(deps: WorkerDeps, claim: Claim, headers: Record<string, string>, base: string): Promise<Outcome> {
  const deadline = Date.parse(claim.leaseExpiresAt)
  const adapter = claim.model && deps.adapterFor ? deps.adapterFor(claim.model) : deps.adapter
  const start = deps.now()
  let backend = adapter.backend
  let model = adapter.model
  let promptVersion = adapter.promptVersion
  let fieldSuggestion: FieldSuggestion | undefined
  let stageError: StageError | undefined
  let suggestions: string[] = []
  let usage: Record<string, number> | undefined
  if (claim.stage) {
    if (!deps.suggestFields) {
      deps.log('No handler is configured for this pipeline stage')
      return 'dropped'
    }
    const result = await deps.suggestFields({ stage: claim.stage, plate: claim.plate, model: claim.model, ...(claim.groupScope ? { groupScope: claim.groupScope } : {}), ...(claim.standardId ? { standardId: claim.standardId } : {}), ...(claim.stageOptions ? { options: claim.stageOptions } : {}) })
    fieldSuggestion = result.fieldSuggestion
    stageError = result.stageError
    backend = result.backend
    model = result.model
    promptVersion = result.promptVersion
    usage = result.usage
  } else {
    let imageB64: string
    try {
      imageB64 = await deps.readImage(process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' ? claim.plate.imageUrl || claim.plate.image : claim.plate.image)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      backend = 'missing-image'
      imageB64 = ''
    }
    if (backend !== 'missing-image') {
      const result = await adapter.suggest({ imageB64, plate: claim.plate })
      suggestions = result.tags
      usage = result.usage
    }
  }
  const body = JSON.stringify({ claimId: claim.claimId, suggestions, ...(fieldSuggestion ? { fieldSuggestion } : {}), ...(stageError ? { stageError } : {}), backend, model, promptVersion, durationMs: Math.max(0, deps.now() - start), ...(usage ? { usage } : {}) })
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

export async function runLoop(deps: WorkerDeps, { idleMs, concurrency = 1 }: { idleMs: number; concurrency?: number }): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error('Invalid concurrency')
  let stopped = false
  async function lane() {
    while (!stopped) {
      try {
        const outcome = await runOnce(deps)
        if (outcome === 'stopped') { stopped = true; return }
        if (outcome === 'idle') await deps.sleep(idleMs)
      } catch (error) {
        deps.log(`Worker iteration failed: ${error instanceof Error ? error.message : String(error)}`)
        await deps.sleep(idleMs)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, lane))
}
