export type Counts = { truePositive: number; falsePositive: number; falseNegative: number }
export type Score = Counts & { precision: number; recall: number; f1: number }

function metrics(counts: Counts): Score {
  const { truePositive: tp, falsePositive: fp, falseNegative: fn } = counts
  const precision = tp + fp === 0 ? (fn === 0 ? 1 : 0) : tp / (tp + fp)
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
  return { ...counts, precision, recall, f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall) }
}

export function scoreTags(suggested: string[], curated: string[]): Score {
  const normalize = (tags: string[]) => new Set(tags.map(tag => tag.trim().toLowerCase()).filter(Boolean))
  const actual = normalize(suggested)
  const expected = normalize(curated)
  const truePositive = [...actual].filter(tag => expected.has(tag)).length
  return metrics({ truePositive, falsePositive: actual.size - truePositive, falseNegative: expected.size - truePositive })
}

export function overallScore(scores: Counts[]): Score {
  return metrics(scores.reduce((sum, score) => ({
    truePositive: sum.truePositive + score.truePositive,
    falsePositive: sum.falsePositive + score.falsePositive,
    falseNegative: sum.falseNegative + score.falseNegative,
  }), { truePositive: 0, falsePositive: 0, falseNegative: 0 }))
}
