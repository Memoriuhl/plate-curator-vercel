import { createHook, sleep } from 'workflow'

export async function researchRun(jobId: string) {
  'use workflow'
  const admission = createHook({ token: `research-start:${jobId}` })
  await dispatchResearch(jobId)
  for (let attempt = 0; attempt <= 30; attempt++) {
    const state = await settleResearch(jobId)
    if (!['queued', 'running'].includes(state ?? 'missing')) return { outcome: state, admission: admission.token }
    await sleep('10s')
  }
  return { outcome: await settleResearch(jobId), admission: admission.token }
}

async function dispatchResearch(jobId: string) {
  'use step'
  const { researchDeps } = await import('../lib/server/research-context')
  const { dispatchEveResearch } = await import('../lib/research/hosted')
  const { researchServiceToken } = await import('../lib/research/tokens')
  const { researchRequestMessage } = await import('../lib/research/request')
  const deps = await researchDeps()
  return dispatchEveResearch(deps, jobId, async job => {
    const base = process.env.RESEARCH_EVE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
    const token = await researchServiceToken(job, process.env.RESEARCH_SERVICE_SECRET ?? '')
    const response = await fetch(`${base.replace(/\/$/, '')}/eve/v1/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {}) }, body: JSON.stringify({ operationId: job.id, message: researchRequestMessage(job.input) }), signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`Eve research dispatch failed: ${response.status}`)
    const receipt = await response.json()
    if (typeof receipt.sessionId !== 'string' || typeof receipt.deliveryId !== 'string') throw new Error('Eve returned no session/delivery receipt')
    return { sessionId: receipt.sessionId, deliveryId: receipt.deliveryId }
  })
}

async function settleResearch(jobId: string) {
  'use step'
  const { researchDeps } = await import('../lib/server/research-context')
  const { researchState } = await import('../lib/research/storage')
  const { finishEveResearch } = await import('../lib/research/hosted')
  return (await finishEveResearch(await researchDeps(), jobId, await researchState()))?.state
}
