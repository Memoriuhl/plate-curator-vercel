import type { ReviewStore } from '../review/types'
import type { ResearchJob } from './types'

export type ResearchToken = { hash: string; workerId: string; env: string; createdAt: number; revokedAt: number | null }
export interface ResearchTransaction {
  review?: ReviewStore
  get(id: string): Promise<ResearchJob | null>
  list(): Promise<ResearchJob[]>
  set(job: ResearchJob): void
}
export interface ResearchStore {
  env: string
  transaction<T>(run: (tx: ResearchTransaction) => Promise<T>, review?: ReviewStore): Promise<T>
  getToken(hash: string): Promise<ResearchToken | null>
  setToken(token: ResearchToken): Promise<void>
}
