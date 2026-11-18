import { createHook, sleep } from 'workflow'

/** Dispatch a hosted research job and poll its result through the deadline. */
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

/**
 * Deliver the research request to Eve in a step with the configured deploy protection
 * credentials.
 */
async function dispatchResearch(jobId: string) {
  'use step'
  const { researchDeps } = await import('../lib/server/research-context')
  const { dispatchEveResearch } = await import('../lib/research/hosted')
  const { createEveResearchDelivery } = await import('../lib/research/delivery')
  const deps = await researchDeps()
  return dispatchEveResearch(deps, jobId, async job => {
    const baseUrl = process.env.RESEARCH_EVE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
    return createEveResearchDelivery(job, { baseUrl, secret: process.env.RESEARCH_SERVICE_SECRET ?? '', deploymentHost: process.env.VERCEL_URL,
      trustedOidc: process.env.VERCEL ? async () => (await import('@vercel/oidc')).getVercelOidcToken() : undefined,
      protectionBypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET, fetch,
    })
  })
}

/** Settle hosted research from the evidence and draft recorded by the remote agent. */
async function settleResearch(jobId: string) {
  'use step'
  const { researchDeps } = await import('../lib/server/research-context')
  const { researchState } = await import('../lib/research/storage')
  const { finishEveResearch } = await import('../lib/research/hosted')
  return (await finishEveResearch(await researchDeps(), jobId, await researchState()))?.state
}
