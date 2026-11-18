import { savedResearchSourcesHeader } from '@/lib/research/enrichment'
import { reportLocalWorkerCapabilities } from '@/lib/jobs/capabilities'
import { currentWorker, jobsDeps } from '@/lib/server/context'
import { badRequest, json, readJson } from '@/lib/server/respond'

/** Authenticate the local worker and accept its validated capability heartbeat. */
export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1') return json({ error: 'not_found' }, 404)
  const worker = await currentWorker(request)
  if (!worker.ok) return worker.response
  const body = await readJson(request)
  return body && await reportLocalWorkerCapabilities(jobsDeps(), worker.workerId, body.capabilities, request.headers.get(savedResearchSourcesHeader) === '1') ? json({ ok: true }) : badRequest()
}
