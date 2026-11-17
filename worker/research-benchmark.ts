import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { plateRevision } from '../lib/review/revision'
import type { Snapshot } from '../lib/catalog/types'
import type { ResearchInput } from '../lib/research/types'

export function researchRunOptions(args: string[]) {
  const value = (key: string) => { const at = args.indexOf(key); return at < 0 ? undefined : args[at + 1] }
  const run = args.includes('--run')
  const budgetUsd = Number(value('--budget-usd') ?? 0)
  if (run && (!Number.isFinite(budgetUsd) || budgetUsd <= 0)) throw new Error('Running requires a positive --budget-usd')
  return { run, budgetUsd, input: value('--input'), output: value('--output'), manifest: value('--manifest'), executor: value('--executor') ?? 'eve' }
}

export function freezeResearchInputs(snapshot: Snapshot, corpus: { plateId: string; split: string }[]): (ResearchInput & { split: string })[] {
  return corpus.map(item => {
    const plate = snapshot.plates.find(plate => plate.id === item.plateId)
    if (!plate) throw new Error(`Missing corpus plate: ${item.plateId}`)
    return { plateId: plate.id, displayName: plate.displayName, state: plate.state, inputRevision: plateRevision(plate), baselineVersion: snapshot.version, split: item.split }
  })
}

async function main() {
  const options = researchRunOptions(process.argv.slice(2))
  const corpus = JSON.parse(await readFile(resolve('fixtures/research-eval.json'), 'utf8'))
  if (options.run) throw new Error('Measured execution is not configured yet; prepare the frozen manifest first')
  if (!options.input) {
    console.log(JSON.stringify({ mode: 'validate-only', plates: corpus.plates.length, next: 'Pass --input snapshot.json --output eval-results/research-baseline/manifest.json to freeze inputs. No external requests were sent.' }))
    return
  }
  if (!options.output?.startsWith('eval-results/research-')) throw new Error('Manifest output must be under eval-results/research-*')
  const snapshot = JSON.parse(await readFile(resolve(options.input), 'utf8')) as Snapshot
  const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), rubric: corpus.rubric, inputs: freezeResearchInputs(snapshot, corpus.plates) }
  await mkdir(dirname(resolve(options.output)), { recursive: true })
  await writeFile(resolve(options.output), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ manifest: options.output, plates: manifest.inputs.length }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
