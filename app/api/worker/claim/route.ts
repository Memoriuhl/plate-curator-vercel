import { claimNext } from '../../../../lib/jobs/jobs'
import { currentWorker, jobsDeps, reviewDeps } from '../../../../lib/server/context'
import { json } from '../../../../lib/server/respond'

export async function POST(request: Request) {
  const worker = await currentWorker(request)
  if (!worker.ok) return worker.response

  const claim = await claimNext(jobsDeps(), worker.workerId)
  if (!claim) return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } })

  const review = reviewDeps()
  const baseline = await review.baseline(claim.job.plateId)
  const edit = await review.store.getEdit(claim.job.batchId, claim.job.plateId)
  const plate = { ...baseline, ...edit?.fields }
  return json({
    job: { id: claim.job.id, batchId: claim.job.batchId, plateId: claim.job.plateId, inputHash: claim.job.inputHash },
    claimId: claim.claimId,
    leaseExpiresAt: new Date(claim.leaseExpiresAt).toISOString(),
    plate: { id: plate.id, state: plate.state, displayName: plate.displayName, image: plate.image, tags: plate.tags ?? [] },
  })
}
