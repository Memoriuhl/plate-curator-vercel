import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { imageReader } from './images'
import { ollamaAdapter } from './model'

async function main() {
  const repo = process.env.GAME_REPO ?? 'C:\\Users\\16jbe\\Code\\License-Plate-Game'
  const names = (await readdir(join(repo, 'assets', 'plates', 'AK'))).filter((name) => /\.(webp|png|jpe?g)$/i.test(name)).sort().slice(0, 2)
  if (names.length !== 2) throw new Error('Two real images are required')
  const readImage = imageReader(repo)
  const adapter = ollamaAdapter({ url: process.env.OLLAMA_URL ?? 'http://localhost:11434', model: process.env.MODEL ?? 'gemma4:12b' })
  for (const name of names) {
    const start = Date.now()
    const result = await adapter.suggest({ imageB64: await readImage(`AK/${name}`), plate: { displayName: name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '), state: 'AK', tags: [] } })
    console.log(JSON.stringify({ plate: name, tags: result.tags, durationMs: Date.now() - start }))
  }
}

main().catch(() => { console.error('Live model check failed'); process.exitCode = 1 })
