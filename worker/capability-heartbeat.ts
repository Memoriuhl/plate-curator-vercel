import { savedResearchSourcesHeader } from '../lib/research/enrichment'
import type { WorkerDeps } from './run'

type CapabilityDeps = Pick<WorkerDeps, 'capabilities' | 'apiBase' | 'token' | 'protectionBypass' | 'fetch' | 'log' | 'suggestFields'>

export function localCapabilityReport(deps: CapabilityDeps): CapabilityDeps['capabilities'] {
  return process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' && !!process.env.LOCAL_PIPELINE_SCOPE ? deps.capabilities : undefined
}

export async function withCapabilityHeartbeat<T>(deps: CapabilityDeps, run: () => Promise<T>): Promise<T> {
  const capabilities = localCapabilityReport(deps)
  if (!capabilities) return run()
  let pending: Promise<void> | undefined
  const timer = setInterval(() => {
    if (pending) return
    const headers: Record<string, string> = { Authorization: `Bearer ${deps.token}`, 'Content-Type': 'application/json' }
    if (deps.suggestFields) headers[savedResearchSourcesHeader] = '1'
    if (deps.protectionBypass) headers['x-vercel-protection-bypass'] = deps.protectionBypass
    pending = deps.fetch(`${deps.apiBase.replace(/\/+$/, '')}/api/worker/capabilities`, { method: 'POST', headers, body: JSON.stringify({ capabilities }), signal: AbortSignal.timeout(capabilities.pollIntervalMs) })
      .then(async response => { if (!response.ok) deps.log('Local capability heartbeat was rejected'); await response.body?.cancel() })
      .catch(() => { deps.log('Local capability heartbeat failed') })
      .finally(() => { pending = undefined })
  }, capabilities.pollIntervalMs)
  try { return await run() } finally { clearInterval(timer); await pending }
}
