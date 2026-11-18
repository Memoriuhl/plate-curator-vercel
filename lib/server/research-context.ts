import 'server-only'
import { reviewDeps } from './context'
import { activeResearchMember } from '../research/auth'
import { researchDatabase, researchEnvironment } from '../research/storage'
import { firestoreResearchStore } from '../research/firestore-store'
import type { ResearchDeps } from '../research/jobs'
import type { TaggingJob } from '../jobs/types'

export async function hostedQueueResearch(job: TaggingJob) {
  const { jobsDeps } = await import('./context')
  const { researchState } = await import('../research/storage')
  const { activeResearchOwner } = await import('../research/auth')
  const { executeQueueResearch } = await import('../research/queue-hosted')
  const { createEveResearchDelivery } = await import('../research/delivery')
  if (process.env.RESEARCH_ENABLE_MODEL_CALLS !== 'true') throw Error('Hosted research model calls are disabled')
  return executeQueueResearch(jobsDeps(), job, {
    state: await researchState(), activeOwner: activeResearchOwner,
    deliver: (job, input, message) => createEveResearchDelivery({ id: job.id, env: job.env, requestedBy: job.requestedBy, input }, {
      baseUrl: process.env.RESEARCH_EVE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'),
      secret: process.env.RESEARCH_SERVICE_SECRET ?? '', deploymentHost: process.env.VERCEL_URL,
      trustedOidc: process.env.VERCEL ? async () => (await import('@vercel/oidc')).getVercelOidcToken() : undefined,
      protectionBypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET, fetch,
    }, message),
  })
}

export async function researchDeps(): Promise<ResearchDeps> {
  return { store: firestoreResearchStore(await researchDatabase(), researchEnvironment()), review: reviewDeps(), active: activeResearchMember, now: Date.now, id: () => crypto.randomUUID(), hostedEnabled: process.env.RESEARCH_ENABLE_MODEL_CALLS === 'true', legacyRevision: process.env.RESEARCH_LEGACY_REVISION }
}

export async function readResearchJson(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get('content-length')) > 900000) return null
  const text = await request.text()
  if (Buffer.byteLength(text) > 900000) return null
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : null } catch { return null }
}

export function researchResponse<T>(result: { ok: true; value: T } | { ok: false; error: string }, success = 200) {
  const status = result.ok ? success : result.error === 'forbidden' ? 403 : result.error === 'not_found' ? 404 : result.error === 'unavailable' ? 503 : result.error === 'invalid_result' || result.error === 'invalid_state' ? 400 : 409
  return Response.json(result, { status, headers: { 'Cache-Control': 'private, no-store' } })
}
