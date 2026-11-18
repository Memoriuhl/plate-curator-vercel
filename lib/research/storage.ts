import { createHash } from 'node:crypto'
import type { Firestore } from '@google-cloud/firestore'
import type { ResearchStateStore } from './state'
import { fileResearchState } from './file-state'

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

export async function researchState(): Promise<ResearchStateStore> {
  if (process.env.EVE_DEV === '1' && !process.env.VERCEL) return fileResearchState('.eve/research')
  return firestoreResearchState(await researchDatabase(), researchEnvironment())
}
