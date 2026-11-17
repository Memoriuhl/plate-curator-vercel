import { gatewayAdapter, ollamaAdapter, type ModelAdapter } from './model'
import { imageReader } from './images'
import { runLoop, type WorkerDeps } from './run'
import { assertLocalWorker } from './local'
import { createTextStageHandler } from './pipeline/text'
import { createImageGroupRunner, localVisionTiebreak } from './image-group'
import { legacyEmbeddingRunner } from './group-embedding'
import { detectGroupRuntime } from './group-capabilities'
import { imageGroupCapabilities } from '../lib/jobs/image-options'

async function main() {
  const { API_BASE, GAME_REPO, VERCEL_PROTECTION_BYPASS } = process.env
  const token = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' ? process.env.LOCAL_PIPELINE_WORKER_TOKEN : process.env.WORKER_TOKEN
  if (!API_BASE || !token || !GAME_REPO) throw new Error('API_BASE, a worker token and GAME_REPO are required')
  const idleMs = Number(process.env.IDLE_MS ?? 5000)
  if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error('IDLE_MS must be positive')
  const backend = process.env.MODEL_BACKEND ?? 'local'
  if (!['local', 'hosted'].includes(backend)) throw new Error('Invalid MODEL_BACKEND')
  if (backend === 'hosted' && !process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY is required')
  const concurrency = Number(process.env.CONCURRENCY ?? 1)
  assertLocalWorker(API_BASE, concurrency)
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1') process.title = 'pcv-local-pipeline'
  const adapter = backend === 'hosted' ? gatewayAdapter({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '', model: process.env.AI_GATEWAY_MODEL }) : ollamaAdapter({ url: process.env.OLLAMA_URL ?? 'http://localhost:11434', model: process.env.MODEL ?? 'gemma4:12b' })
  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434'
  const adapters = new Map<string, ModelAdapter>([[adapter.model, adapter]])
  const adapterFor = backend === 'local' ? (model: string) => adapters.get(model) ?? adapters.set(model, ollamaAdapter({ url: ollamaUrl, model })).get(model)! : undefined
  const readImage = imageReader(GAME_REPO)
  const textStages = createTextStageHandler({ url: ollamaUrl, onRejected: reasons => console.log(`Rejected unsupported stage fields: ${reasons.join('; ')}`) })
  const { LOCAL_GROUP_PYTHON, LOCAL_GROUP_LEGACY_REPO, LOCAL_GROUP_CACHE } = process.env
  const embed = LOCAL_GROUP_PYTHON && LOCAL_GROUP_LEGACY_REPO && LOCAL_GROUP_CACHE
    ? legacyEmbeddingRunner({ python: LOCAL_GROUP_PYTHON, legacyRepo: LOCAL_GROUP_LEGACY_REPO, cache: LOCAL_GROUP_CACHE, readImage })
    : undefined
  const runtime = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' ? await detectGroupRuntime(process.env) : undefined
  const availability = imageGroupCapabilities(runtime)
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' && (!Number.isInteger(idleMs) || idleMs < 100 || idleMs > 60000)) throw new Error('Local IDLE_MS must be between 100 and 60000')
  const capabilities = runtime ? { group: availability.group, embeddings: availability.embeddings, mask: availability.backgroundMask, vision: availability.visionTiebreak, pollIntervalMs: idleMs } : undefined
  const imageStages = createImageGroupRunner({ embed, runtime, tiebreak: localVisionTiebreak({ url: ollamaUrl, readImage }) })
  const suggestFields: WorkerDeps['suggestFields'] = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
    ? input => ['find-image', 'group'].includes(input.stage) ? imageStages(input) : textStages(input)
    : undefined
  await runLoop({ apiBase: API_BASE, token, protectionBypass: VERCEL_PROTECTION_BYPASS, capabilities, fetch, adapter, adapterFor, suggestFields, readImage, now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log: console.log }, { idleMs, concurrency })
}

main().catch(() => { console.error('Worker stopped after a configuration or startup failure'); process.exitCode = 1 })
