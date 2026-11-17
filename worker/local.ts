import { localPipelineScope } from '../lib/jobs/local-scope'

export function assertLocalWorker(apiBase: string, concurrency: number) {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1') return
  localPipelineScope()
  const url = new URL(apiBase)
  if (url.hostname !== 'localhost' || url.protocol !== 'http:' || url.username || url.password || concurrency !== 1) {
    throw new Error('Local pipeline worker needs an HTTP localhost API and concurrency 1')
  }
}
