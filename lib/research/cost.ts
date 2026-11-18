export function reportedGatewayCost(metadata: unknown): number | undefined {
  const value = (metadata as { gateway?: { cost?: unknown } } | undefined)?.gateway?.cost
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  if (typeof value === 'string' && !value.trim()) return undefined
  const cost = Number(value)
  return Number.isFinite(cost) && cost >= 0 ? cost : undefined
}
