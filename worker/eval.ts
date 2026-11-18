import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { overallScore, scoreTags } from '../lib/eval/score'
import { evaluationFailed, suggestWithRetry } from '../lib/eval/run'
import { imageReader } from './images'
import { ollamaAdapter } from './model'

type EvalPlate = { id: string; state: string; displayName: string; image: string; tags: string[] }

/**
 * Run tagging against the evaluation corpus and fail the command when its quality
 * threshold is missed.
 */
async function main() {
  const repo = process.env.GAME_REPO
  if (!repo?.trim()) {
    console.error('GAME_REPO is required')
    process.exitCode = 1
    return
  }
  const fixture = JSON.parse(await readFile(resolve('fixtures/tag-eval.json'), 'utf8')) as { plates: EvalPlate[] }
  const threshold = JSON.parse(await readFile(resolve('fixtures/tag-eval-threshold.json'), 'utf8')) as { minimumF1: number }
  if (!Number.isFinite(threshold.minimumF1) || threshold.minimumF1 < 0 || threshold.minimumF1 > 1) throw new Error('Invalid F1 threshold')
  if (fixture.plates.length < 25 || fixture.plates.length > 40 || new Set(fixture.plates.map(plate => plate.id)).size !== fixture.plates.length) throw new Error('Expected 25–40 distinct evaluation Plates')
  const readImage = imageReader(repo)
  const adapter = ollamaAdapter({ url: process.env.OLLAMA_URL ?? 'http://localhost:11434', model: process.env.MODEL ?? 'gemma4:12b' })
  const date = new Date().toISOString()
  const plates = []
  for (const plate of fixture.plates) {
    const start = performance.now()
    const imageB64 = await readImage(plate.image)
    const result = await suggestWithRetry(() => adapter.suggest({ imageB64, plate: { ...plate, tags: [] } }))
    const durationMs = Math.round(performance.now() - start)
    plates.push({ ...plate, suggestions: result.tags, score: scoreTags(result.tags, plate.tags), durationMs, usage: result.usage, attempts: result.attempts, ...(result.error ? { error: result.error } : {}) })
    console.log(`${plates.length}/${fixture.plates.length} ${plate.state}: F1 ${plates.at(-1)!.score.f1.toFixed(3)}, ${durationMs}ms`)
  }
  const overall = overallScore(plates.map(plate => plate.score))
  const totalMs = plates.reduce((sum, plate) => sum + plate.durationMs, 0)
  const failedPlates = plates.filter(plate => plate.error).length
  const report = {
    date, model: adapter.model, backend: adapter.backend, promptVersion: adapter.promptVersion,
    settings: { temperature: 0.1, num_ctx: 4096, think: false, stream: false, keep_alive: '30m' },
    aggregation: 'micro', emptySetPolicy: 'Both empty scores 1; empty suggestions against nonempty curated scores 0; empty curated recall is 1.',
    minimumF1: threshold.minimumF1, maximumFailureRate: 0.2, attemptsPerPlate: 2, failedPlates, plates, overall, timings: { totalMs, meanMs: totalMs / plates.length },
  }
  await mkdir('eval-results', { recursive: true })
  await writeFile(`eval-results/tag-eval-${date.replace(/:/g, '-')}.json`, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Precision ${overall.precision.toFixed(3)}, recall ${overall.recall.toFixed(3)}, F1 ${overall.f1.toFixed(3)}; ${totalMs}ms; ${failedPlates} failures`)
  if (evaluationFailed(overall.f1, threshold.minimumF1, failedPlates, plates.length)) process.exitCode = 1
}

main().catch(() => { console.error('Evaluation failed; check fixtures, local model and image configuration'); process.exitCode = 1 })
