import { expect, it } from 'vitest'
import { evaluationFailed, suggestWithRetry } from '../../lib/eval/run'

it('preserves successful suggestions without retrying', async () => {
  expect(
    await suggestWithRetry(async () => ({
      tags: ['blue'],
      usage: { eval_count: 10 },
    }))
  ).toEqual({ tags: ['blue'], usage: { eval_count: 10 }, attempts: 1 })
})

it('recovers from one failed inference', async () => {
  let attempts = 0
  const result = await suggestWithRetry(async () => {
    if (++attempts === 1) throw new Error('Inference failed')
    return { tags: ['white'] }
  })
  expect(result).toEqual({ tags: ['white'], attempts: 2 })
})

it('records persistent failure as empty suggestions after one retry', async () => {
  expect(
    await suggestWithRetry(async () => {
      throw new Error('Inference failed')
    })
  ).toEqual({ tags: [], attempts: 2, error: 'tagging_failed' })
})

it.each([
  { f1: 0.6, failed: 0, rejects: false },
  { f1: 0.599, failed: 0, rejects: true },
  { f1: 0.65, failed: 1, rejects: false },
  { f1: 0.65, failed: 6, rejects: false },
  { f1: 0.65, failed: 7, rejects: true },
])(
  'applies the F1 and failure-rate cutoffs: $f1, $failed failures',
  ({ f1, failed, rejects }) => {
    expect(evaluationFailed(f1, 0.6, failed, 30)).toBe(rejects)
  }
)
