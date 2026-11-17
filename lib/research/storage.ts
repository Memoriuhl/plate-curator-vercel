import { createHash } from 'node:crypto'
import type { Firestore } from '@google-cloud/firestore'
import type { ResearchStateStore } from './state'

let database: Firestore | undefined
export function researchEnvironment() {
  return process.env.VERCEL_ENV === 'preview' ? `preview:${process.env.VERCEL_GIT_COMMIT_REF ?? 'unknown'}` : process.env.VERCEL_ENV ?? 'development'
}

export async function researchDatabase(): Promise<Firestore> {
  if (!database) {
    const { Firestore } = await import('@google-cloud/firestore')
    if (process.env.FIRESTORE_EMULATOR_HOST) database = new Firestore({ projectId: process.env.GCP_PROJECT_ID ?? 'demo-plate-curator' })
    else {
      const { gcpAuthClient } = await import('../gcp/credentials')
      if (!process.env.GCP_PROJECT_ID) throw new Error('GCP_PROJECT_ID is required for persistent research state')
      database = new Firestore({ projectId: process.env.GCP_PROJECT_ID, authClient: gcpAuthClient() })
    }
  }
  return database
}

export function firestoreResearchState(db: Firestore, env: string): ResearchStateStore {
  const ref = (key: string) => db.collection('researchState').doc(createHash('sha256').update(env + '\n' + key).digest('hex'))
  return {
    async read<T>(key: string) { const record = await ref(key).get(); return record.exists && record.get('env') === env ? record.get('value') as T : null },
    update<T, R>(key: string, change: (value: T | null) => { value: T; result: R }) {
      return db.runTransaction(async transaction => {
        const record = await transaction.get(ref(key))
        const changed = change(record.exists && record.get('env') === env ? record.get('value') as T : null)
        transaction.set(ref(key), { env, key, value: changed.value })
        return changed.result
      })
    },
  }
}

let localPending = Promise.resolve()
function localResearchState(): ResearchStateStore {
  return {
    async read<T>(key: string) {
      await localPending
      const { readFile } = await import('node:fs/promises')
      try { return JSON.parse(await readFile(`.eve/research/${createHash('sha256').update(key).digest('hex')}.json`, 'utf8')) as T }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    },
    async update<T, R>(key: string, change: (value: T | null) => { value: T; result: R }) {
      let release!: () => void
      const previous = localPending
      localPending = new Promise(resolve => { release = resolve })
      await previous
      const { mkdir, readFile, writeFile, rename } = await import('node:fs/promises')
      try {
        const path = `.eve/research/${createHash('sha256').update(key).digest('hex')}.json`
        let value: T | null = null
        try { value = JSON.parse(await readFile(path, 'utf8')) as T } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        const changed = change(value)
        await mkdir('.eve/research', { recursive: true })
        await writeFile(path + '.tmp', JSON.stringify(changed.value))
        await rename(path + '.tmp', path)
        return changed.result
      } finally { release() }
    },
  }
}

export async function researchState(): Promise<ResearchStateStore> {
  if (process.env.EVE_DEV === '1' && !process.env.VERCEL) return localResearchState()
  return firestoreResearchState(await researchDatabase(), researchEnvironment())
}
