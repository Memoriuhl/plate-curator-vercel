function increasingSubsequence(values: number[]): Set<number> {
  const tails: number[] = []
  const previous = new Array<number>(values.length).fill(-1)
  for (let index = 0; index < values.length; index += 1) {
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (values[tails[middle]] < values[index]) low = middle + 1
      else high = middle
    }
    if (low > 0) previous[index] = tails[low - 1]
    tails[low] = index
  }
  const retained = new Set<number>()
  for (let index = tails.at(-1) ?? -1; index !== -1; index = previous[index]) retained.add(index)
  return retained
}

export function orderDifferences(baseline: string[], order: string[]) {
  const positions = new Map(baseline.map((id, index) => [id, index]))
  const candidates = order.flatMap((plateId, after) => {
    const before = positions.get(plateId)
    return before === undefined ? [] : [{ plateId, before, after }]
  })
  const retained = increasingSubsequence(candidates.map(plate => plate.before))
  return candidates.filter((_, index) => !retained.has(index))
}

export function restorePlateOrder(baseline: string[], order: string[], plateId: string): string[] {
  const before = baseline.indexOf(plateId)
  if (before < 0 || !order.includes(plateId)) return order
  const remaining = order.filter(id => id !== plateId)
  const moved = new Set(orderDifferences(baseline, remaining).map(({ plateId }) => plateId))
  const anchors = new Set(remaining.filter(id => !moved.has(id)))
  const next = baseline.slice(before + 1).find(id => anchors.has(id))
  const previous = baseline.slice(0, before).findLast(id => anchors.has(id))
  const earliest = previous ? remaining.indexOf(previous) + 1 : 0
  const latest = next ? remaining.indexOf(next) : remaining.length
  const index = Math.min(latest, Math.max(earliest, before))
  return [...remaining.slice(0, index), plateId, ...remaining.slice(index)]
}
