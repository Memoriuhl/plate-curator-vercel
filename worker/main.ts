import { ollamaAdapter } from './model'
import { imageReader } from './images'
import { runLoop } from './run'

async function main() {
  const { API_BASE, WORKER_TOKEN, GAME_REPO, VERCEL_PROTECTION_BYPASS } = process.env
  if (!API_BASE || !WORKER_TOKEN || !GAME_REPO) throw new Error('API_BASE, WORKER_TOKEN and GAME_REPO are required')
  const idleMs = Number(process.env.IDLE_MS ?? 5000)
  if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error('IDLE_MS must be positive')
  await runLoop({ apiBase: API_BASE, token: WORKER_TOKEN, protectionBypass: VERCEL_PROTECTION_BYPASS, fetch, adapter: ollamaAdapter({ url: process.env.OLLAMA_URL ?? 'http://localhost:11434', model: process.env.MODEL ?? 'gemma4:12b' }), readImage: imageReader(GAME_REPO), now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log: console.log }, { idleMs })
}

main().catch(() => { console.error('Worker stopped after a configuration or startup failure'); process.exitCode = 1 })
