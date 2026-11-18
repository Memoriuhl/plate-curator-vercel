/**
 * Build a Vercel workflow dashboard link when the ID and deployment environment are
 * recognized.
 */
export function workflowVisibilityUrl(
  workflowId: string | undefined,
  environment: string | undefined,
  world?: string,
  webPort = process.env.WORKFLOW_WEB_PORT
): string | null {
  if (!workflowId) return null
  const id = encodeURIComponent(workflowId)
  if (world === 'local') {
    const port =
      /^[0-9]{1,5}$/.test(webPort ?? '') &&
      Number(webPort) > 0 &&
      Number(webPort) <= 65535
        ? Number(webPort)
        : 3456
    return `http://localhost:${port}/run/${id}`
  }
  if (!['production', 'preview'].includes(environment ?? '')) return null
  return `https://vercel.com/memoriuhl/plate-curator-vercel/workflows/runs/${id}?environment=${environment}`
}

export function recordedWorkflowUrl(
  workflowId: string | undefined,
  recorded?: string | null
): string | null {
  const { VERCEL_ENV, WORKFLOW_TARGET_WORLD } = process.env
  const resolved = workflowVisibilityUrl(
    workflowId,
    VERCEL_ENV,
    WORKFLOW_TARGET_WORLD
  )
  return WORKFLOW_TARGET_WORLD === 'local' && resolved
    ? resolved
    : (recorded ?? resolved)
}
