import { gatewayAdapter, ollamaAdapter, type ModelAdapter } from './model'
import { imageReader } from './images'
import { runLoop } from './run'

async function main() {
  const { API_BASE, WORKER_TOKEN, GAME_REPO, VERCEL_PROTECTION_BYPASS } = process.env
  if (!API_BASE || !WORKER_TOKEN || !GAME_REPO) throw new Error('API_BASE, WORKER_TOKEN and GAME_REPO are required')
  const idleMs = Number(process.env.IDLE_MS ?? 5000)
  if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error('IDLE_MS must be positive')
  const backend = process.env.MODEL_BACKEND ?? 'local'
  if (!['local', 'hosted'].includes(backend)) throw new Error('Invalid MODEL_BACKEND')
  if (backend === 'hosted' && !process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY is required')
  const concurrency = Number(process.env.CONCURRENCY ?? 1)
  const adapter = backend === 'hosted' ? gatewayAdapter({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '', model: process.env.AI_GATEWAY_MODEL }) : ollamaAdapter({ url: process.env.OLLAMA_URL ?? 'http://localhost:11434', model: process.env.MODEL ?? 'gemma4:12b' })
  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434'
  const adapters = new Map<string, ModelAdapter>([[adapter.model, adapter]])
  const adapterFor = backend === 'local' ? (model: string) => adapters.get(model) ?? adapters.set(model, ollamaAdapter({ url: ollamaUrl, model })).get(model)! : undefined
  await runLoop({ apiBase: API_BASE, token: WORKER_TOKEN, protectionBypass: VERCEL_PROTECTION_BYPASS, fetch, adapter, adapterFor, readImage: imageReader(GAME_REPO), now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log: console.log }, { idleMs, concurrency })
}

main().catch(() => { console.error('Worker stopped after a configuration or startup failure'); process.exitCode = 1 })
