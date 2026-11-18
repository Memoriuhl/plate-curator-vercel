export function workflowVisibilityUrl(workflowId: string | undefined, environment: string | undefined, world?: string): string | null {
  if (!workflowId) return null
  const id = encodeURIComponent(workflowId)
  if (world === 'local') return `http://localhost:3456/run/${id}`
  if (!['production', 'preview'].includes(environment ?? '')) return null
  return `https://vercel.com/memoriuhl/plate-curator-vercel/workflows/runs/${id}?environment=${environment}`
}

export function recordedWorkflowUrl(workflowId: string | undefined, recorded?: string | null): string | null {
  const { VERCEL_ENV, WORKFLOW_TARGET_WORLD } = process.env
  const resolved = workflowVisibilityUrl(workflowId, VERCEL_ENV, WORKFLOW_TARGET_WORLD)
  return WORKFLOW_TARGET_WORLD === 'local' && resolved ? resolved : recorded ?? resolved
}
