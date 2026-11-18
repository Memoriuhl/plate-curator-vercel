import type { ResearchJob } from './types'
import { researchServiceToken } from './tokens'
import { researchRequestMessage } from './request'

type Deps = { baseUrl: string; secret: string; deploymentHost?: string; trustedOidc?: () => Promise<string>; protectionBypass?: string; fetch: typeof fetch }
export async function createEveResearchDelivery(job: Pick<ResearchJob, 'id' | 'env' | 'requestedBy' | 'input'>, deps: Deps, message = researchRequestMessage(job.input)) {
  const token = await researchServiceToken(job, deps.secret)
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  if (deps.protectionBypass) headers['x-vercel-protection-bypass'] = deps.protectionBypass
  if (deps.trustedOidc && new URL(deps.baseUrl).host === deps.deploymentHost) headers['x-vercel-trusted-oidc-idp-token'] = await deps.trustedOidc()
  const response = await deps.fetch(`${deps.baseUrl.replace(/\/$/, '')}/eve/v1/session`, { method: 'POST', headers, body: JSON.stringify({ operationId: job.id, message }), signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`Eve research dispatch failed: ${response.status}`)
  const receipt = await response.json()
  if (typeof receipt.sessionId !== 'string' || typeof receipt.deliveryId !== 'string') throw new Error('Eve returned no session/delivery receipt')
  return { sessionId: receipt.sessionId, deliveryId: receipt.deliveryId }
}
