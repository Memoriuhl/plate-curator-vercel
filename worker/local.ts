import { localPipelineScope } from '../lib/jobs/local-scope'

export function assertLocalWorker(apiBase: string, concurrency: number) {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1') return
  localPipelineScope()
  const url = new URL(apiBase)
  const loopback = url.protocol === 'http:' && url.hostname === 'localhost'
  const hosted = url.protocol === 'https:' && url.origin === process.env.LOCAL_PIPELINE_HOSTED_ORIGIN &&
    url.pathname === '/' && !url.search && !url.hash
  if ((!loopback && !hosted) || url.username || url.password || concurrency !== 1) {
    throw new Error('Local pipeline worker needs an HTTP localhost API or the configured hosted HTTPS origin and concurrency 1')
  }
}
