type Suggestion = { tags: string[]; usage?: Record<string, number> }

export async function suggestWithRetry(suggest: () => Promise<Suggestion>): Promise<Suggestion & { attempts: number; error?: string }> {
  for (let attempts = 1; attempts <= 2; attempts++) {
    try {
      return { ...await suggest(), attempts }
    } catch {
      if (attempts === 2) return { tags: [], attempts, error: 'tagging_failed' }
    }
  }
  throw new Error('Evaluation retry exhausted')
}

export function evaluationFailed(f1: number, minimumF1: number, failedPlates: number, totalPlates: number): boolean {
  return f1 < minimumF1 || failedPlates / totalPlates > 0.2
}
