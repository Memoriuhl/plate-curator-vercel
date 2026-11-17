import { claimNext } from '../../../../lib/jobs/jobs'
import { currentWorker, jobsDeps, reviewDeps } from '../../../../lib/server/context'
import { json } from '../../../../lib/server/respond'
import { taggingModel } from '../../../../lib/tagging/models'

export async function POST(request: Request) {
  const worker = await currentWorker(request)
  if (!worker.ok) return worker.response

  const claim = await claimNext(jobsDeps(), worker.workerId)
  if (!claim) return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } })

  const plate = claim.job.inputPlate ?? await legacyInput(claim.job.batchId, claim.job.plateId)
  return json({
    job: { id: claim.job.id, batchId: claim.job.batchId, plateId: claim.job.plateId, inputHash: claim.job.inputHash },
    ...(claim.job.stage ? { stage: claim.job.stage } : {}),
    claimId: claim.claimId,
    leaseExpiresAt: new Date(claim.leaseExpiresAt).toISOString(),
    ...(taggingModel(claim.job.modelId)?.runsOn === 'desktop' ? { model: taggingModel(claim.job.modelId)!.model } : {}),
    plate: { id: plate.id, state: plate.state, displayName: plate.displayName, image: plate.image, tags: plate.tags ?? [],
      ...(claim.job.stage ? { description: plate.description ?? null, sourceUrl: plate.sourceUrl ?? null, wikiUrl: plate.wikiUrl ?? null } : {}),
    },
  })
}

async function legacyInput(batchId: string, plateId: string) {
  const review = reviewDeps()
  const baseline = await review.baseline(plateId)
  const edit = await review.store.getEdit(batchId, plateId)
  return { ...baseline, ...edit?.fields }
}
