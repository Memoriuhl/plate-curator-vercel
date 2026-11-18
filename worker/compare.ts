import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { benchmark, RequestBudget, type Plate, type Run } from './benchmark'
import { gatewayPricing, HOSTED_MODEL } from './model'
import { imageReader } from './images'
import { reportHtml, summaryCsv, runFile } from './report'

/**
 * Run or compare model benchmark lanes with shared limits and report their measured
 * results.
 */
async function main() {
  const args = process.argv.slice(2)
  /**
   * Read an optional command-line flag value with a fallback when no value follows it.
   */
  const value = (name: string, fallback: string) => {
    const index = args.indexOf(name)
    if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) throw new Error(`Missing ${name}`)
    return index < 0 ? fallback : args[index + 1]
  }
  const backend = value('--backend', 'local')
  if (!['local', 'hosted'].includes(backend)) throw new Error('Invalid backend')
  const concurrency = Number(value('--concurrency', '1'))
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error('Invalid concurrency')
  const budget = new RequestBudget(Number(value('--max-requests', '300')))
  const fixtureText = await readFile('fixtures/tag-eval.json', 'utf8')
  const fixture = JSON.parse(fixtureText) as { plates: Plate[] }
  if (fixture.plates.length !== 30 || new Set(fixture.plates.map(p => p.id)).size !== 30) throw new Error('Expected 30 distinct Plates')
  const { minimumF1 } = JSON.parse(await readFile('fixtures/tag-eval-threshold.json', 'utf8'))
  if (!process.env.GAME_REPO) throw new Error('GAME_REPO is required')
  const readImage = imageReader(process.env.GAME_REPO)
  const comparison = args.includes('--compare')
  const hosted = comparison || backend === 'hosted'
  if (hosted && !process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY is required')
  const pricing = hosted ? await gatewayPricing(process.env.AI_GATEWAY_MODEL ?? HOSTED_MODEL) : undefined
  let gpu: string | undefined
  try { gpu = execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8' }).trim() } catch {}
  const folder = resolve('eval-results', `${comparison ? 'compare' : 'run'}-${new Date().toISOString().replaceAll(':', '-')}`)
  await mkdir(folder, { recursive: true })
  const maxRateLimitRatio = args.includes('--max-rate-limit-ratio') ? Number(value('--max-rate-limit-ratio', '0.2')) : undefined
  const common = { fixtureText, minimumF1, readImage, budget, pricing, gpu, label: value('--label', ''), maxRateLimitRatio }
  let smokeCost: number | null = null
  if (hosted) {
    const smoke = await benchmark({ ...common, backend: 'hosted', concurrency: 1, plates: fixture.plates.slice(0, 1), maximumAttempts: 1 })
    await writeFile(resolve(folder, 'preflight.json'), JSON.stringify(smoke, null, 2))
    smokeCost = smoke.totalCost
    console.log(`Preflight: F1 ${smoke.overall.f1.toFixed(3)}, cost ${smokeCost}, source ${smoke.costSource}`)
    if (smoke.failedPlates || smoke.cappedPlates || smokeCost === null || smokeCost < 0 || smokeCost > 0.01) throw new Error('Preflight failed or cost needs inspection; matrix not started')
    if (args.includes('--preflight-only')) { console.log(folder); return }
  }
  const matrix: ['local' | 'hosted', number][] = comparison ? [['local', 1], ['local', 4], ['hosted', 1], ['hosted', 4], ['hosted', 8], ['hosted', 16]] : [[backend as 'local' | 'hosted', concurrency]]
  const runs: Run[] = []
  for (const [lane, count] of matrix) {
    let before = ''
    if (lane === 'local') { try { before = execFileSync('hc', ['read', 'gpu-worker-prod'], { encoding: 'utf8' }) } catch {} }
    const run = await benchmark({ ...common, backend: lane, concurrency: count, plates: fixture.plates })
    if (lane === 'local') {
      try {
        const after = execFileSync('hc', ['read', 'gpu-worker-prod'], { encoding: 'utf8' })
        run.contention = before === after ? 'Production worker terminal unchanged (startup output only); claims are not logged, so concurrent production activity is unknown.' : 'Production worker terminal changed during run; inspect private terminal snapshots for contention.'
        await writeFile(resolve(folder, `local-c${count}-worker-output.json`), JSON.stringify({ before, after }, null, 2))
      } catch { run.contention = 'Production worker terminal unavailable; contention unknown.' }
    }
    runs.push(run)
    await writeFile(resolve(folder, runFile(run)), JSON.stringify(run, null, 2))
    await writeFile(resolve(folder, 'summary.csv'), summaryCsv(runs))
    await writeFile(resolve(folder, 'report.html'), reportHtml(runs, smokeCost))
    console.log(`${lane} c${count}: F1 ${run.overall.f1.toFixed(3)}, wall ${(run.wallMs / 1000).toFixed(1)}s, cost ${run.totalCost}, ${run.status}`)
    if (lane === 'hosted' && run.costPerPlate !== null && smokeCost !== null && smokeCost > 0 && run.costPerPlate >= smokeCost * 10) throw new Error('Cost per Plate exceeded 10x preflight; stopped')
    if (run.status === 'capped') break
  }
  console.log(`Artifact: ${folder}; requests ${budget.used}/${budget.maximum}`)
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Comparison failed'); process.exitCode = 1 })
