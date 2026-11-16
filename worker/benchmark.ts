import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { overallScore, scoreTags } from '../lib/eval/score'
import { gatewayAdapter, ollamaAdapter, type Attempt, type Pricing } from './model'

export type Plate = { id: string; state: string; displayName: string; image: string; tags: string[] }
export class RequestBudget {
  used = 0
  constructor(readonly maximum = 300) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error('Invalid request cap')
  }
  take() {
    if (this.used >= this.maximum) throw Object.assign(new Error('capped'), { status: 400 })
    this.used++
  }
}

export async function boundedPool<T, R>(items: T[], concurrency: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error('Concurrency must be 1–64')
  const results: R[] = new Array(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await task(items[index], index)
    }
  }))
  return results
}

export function costs(attempts: Attempt[]) {
  const known = attempts.filter(a => a.cost !== null)
  return { cost: known.length ? known.reduce((sum, a) => sum + a.cost!, 0) : null, costSource: !known.length ? 'unknown' : known.every(a => a.costSource === 'reported') ? 'reported' : 'estimated', missingCostAttempts: attempts.length - known.length }
}

export async function benchmark(options: { backend: 'local' | 'hosted'; concurrency: number; label: string; plates: Plate[]; fixtureText: string; minimumF1: number; readImage: (image: string) => Promise<string>; budget: RequestBudget; pricing?: Pricing; gpu?: string; contention?: string; request?: typeof fetch; maximumAttempts?: number }) {
  const date = new Date().toISOString()
  const start = performance.now()
  const requestStart = options.budget.used
  const plates = await boundedPool(options.plates, options.concurrency, async plate => {
    const activated = performance.now()
    const attempts: Attempt[] = []
    const record = (a: Attempt) => { attempts.push(a) }
    const request = options.request ?? fetch
    const adapter = options.backend === 'hosted'
      ? gatewayAdapter({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '', model: process.env.AI_GATEWAY_MODEL, pricing: options.pricing, fetch: request, beforeRequest: () => options.budget.take(), onAttempt: record })
      : ollamaAdapter({ url: process.env.OLLAMA_URL ?? 'http://localhost:11434', model: process.env.MODEL ?? 'gemma4:12b', fetch: async (url, init) => {
        options.budget.take()
        const began = performance.now()
        const attempt: Attempt = { model: process.env.MODEL ?? 'gemma4:12b', latencyMs: 0, cost: null, costSource: 'unknown' }
        try {
          const response = await request(url, { ...init, signal: AbortSignal.timeout(180000) })
          attempt.status = response.status
          if (response.ok) {
            const body = await response.clone().json()
            attempt.model = body.model ?? attempt.model
            attempt.usage = { prompt_eval_count: body.prompt_eval_count ?? 0, eval_count: body.eval_count ?? 0 }
          }
          return response
        } finally { attempt.latencyMs = performance.now() - began; record(attempt) }
      } })
    let suggestions: string[] = []
    let error: string | undefined
    try {
      if (options.budget.used >= options.budget.maximum) throw new Error('capped')
      const imageB64 = await options.readImage(plate.image)
      for (let retry = 0; retry < (options.maximumAttempts ?? 2); retry++) {
        try { suggestions = (await adapter.suggest({ imageB64, plate: { ...plate, tags: [] } })).tags; error = undefined; break }
        catch (cause) {
          error = cause instanceof Error && cause.message === 'capped' ? 'capped' : 'tagging_failed'
          if (error === 'capped') break
        }
      }
    } catch (cause) { error = cause instanceof Error && cause.message === 'capped' ? 'capped' : 'image_failed' }
    const durationMs = performance.now() - activated
    const inferenceMs = attempts.reduce((sum, a) => sum + a.latencyMs, 0)
    return { ...plate, suggestions, score: scoreTags(suggestions, plate.tags), durationMs, latencyMs: performance.now() - start, queueWaitMs: activated - start, inferenceMs, usage: attempts.at(-1)?.usage, attempts: attempts.length, attemptRecords: attempts, ...costs(attempts), ...(error ? { error } : {}) }
  })
  const wallMs = performance.now() - start
  const successful = plates.filter(p => !p.error)
  const latencies = successful.map(p => p.latencyMs).sort((a, b) => a - b)
  const percentile = (p: number) => latencies.length ? latencies[Math.ceil(p * latencies.length) - 1] : null
  const allAttempts = plates.flatMap(p => p.attemptRecords)
  const total = costs(allAttempts)
  return {
    date, label: options.label, backend: options.backend, model: allAttempts[0]?.model ?? (options.backend === 'hosted' ? process.env.AI_GATEWAY_MODEL ?? 'google/gemini-3.5-flash-lite' : process.env.MODEL ?? 'gemma4:12b'),
    promptVersion: ollamaAdapter({ url: '', model: '' }).promptVersion, fixtureVersion: createHash('sha256').update(options.fixtureText).digest('hex'),
    machine: hostname(), gpu: options.gpu ?? null, contention: options.contention ?? 'Production worker claims cannot be determined from its current terminal output.', concurrency: options.concurrency,
    settings: options.backend === 'local' ? { temperature: 0.1, num_ctx: 4096, think: false, stream: false, keep_alive: '30m' } : { temperature: 0.1 },
    aggregation: 'micro', emptySetPolicy: 'Both empty scores 1; empty suggestions against nonempty curated scores 0; empty curated recall is 1.', minimumF1: options.minimumF1, maximumFailureRate: 0.2, attemptsPerPlate: options.maximumAttempts ?? 2,
    failedPlates: plates.filter(p => p.error && p.error !== 'capped').length, cappedPlates: plates.filter(p => p.error === 'capped').length, status: plates.some(p => p.error === 'capped') ? 'capped' : 'completed',
    plates, overall: overallScore(plates.filter(p => p.error !== 'capped').map(p => p.score)), wallMs, timings: { totalMs: plates.reduce((s, p) => s + p.durationMs, 0), meanMs: plates.reduce((s, p) => s + p.durationMs, 0) / plates.length },
    latency: { p50: percentile(0.5), p95: percentile(0.95), sampleCount: latencies.length, definition: 'Time from batch enqueue to completion; successful Plates only' }, throughput: successful.length * 60000 / wallMs,
    requests: options.budget.used - requestStart, retries: plates.reduce((s, p) => s + Math.max(0, p.attempts - 1), 0), rateLimits: allAttempts.filter(a => a.status === 429).length,
    totalCost: total.cost, costSource: total.costSource, missingCostAttempts: total.missingCostAttempts, costPerPlate: total.cost === null ? null : total.cost / Math.max(1, plates.filter(p => p.attempts).length), pricing: options.pricing ?? null,
  }
}
export type Run = Awaited<ReturnType<typeof benchmark>>
