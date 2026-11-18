export function workflowVisibilityUrl(workflowId: string | undefined, environment: string | undefined): string | null {
  if (!workflowId || !['production', 'preview'].includes(environment ?? '')) return null
  return `https://vercel.com/memoriuhl/plate-curator-vercel/workflows/runs/${encodeURIComponent(workflowId)}?environment=${environment}`
}
