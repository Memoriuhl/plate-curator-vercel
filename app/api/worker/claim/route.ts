import { savedResearchSourcesHeader } from '../../../../lib/research/enrichment'
import { claimNext } from '../../../../lib/jobs/jobs'
import { currentWorker, jobsDeps, reviewDeps } from '../../../../lib/server/context'
import { json } from '../../../../lib/server/respond'
import { taggingModel } from '../../../../lib/tagging/models'
import { parseWorkerCapabilities, reportLocalWorkerCapabilities } from '../../../../lib/jobs/capabilities'
import { readJson, badRequest } from '../../../../lib/server/respond'
import { wakeLocalJob } from '../../../../lib/server/local-queue'
import type { Plate } from '../../../../lib/catalog/types'

/**
 * Authenticate the worker, claim its next eligible job and return the input needed for
 * that stage.
 */
export async function POST(request: Request) {
  const worker = await currentWorker(request)
  if (!worker.ok) return worker.response

  const dependencies = jobsDeps()
  const supportsSavedSources = request.headers.get(savedResearchSourcesHeader) === '1'
  let enhanceImage = false
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' && dependencies.localScope) {
    const body = await readJson(request)
    if (body?.capabilities !== undefined) {
      const capabilities = parseWorkerCapabilities(body.capabilities)
      if (!capabilities || !await reportLocalWorkerCapabilities(dependencies, worker.workerId, capabilities, supportsSavedSources)) return badRequest()
      enhanceImage = capabilities.enhanceImage?.available === true
    }
  }
  const claim = await claimNext(dependencies, worker.workerId, {
    supportsSavedSources,
    enhanceImage,
  })
  if (!claim) return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } })

  const plate = claim.job.inputPlate ?? await legacyInput(claim.job.batchId, claim.job.plateId)
  if (claim.job.queueRunId) await wakeLocalJob(claim.job)
  return json({
    job: { id: claim.job.id, batchId: claim.job.batchId, plateId: claim.job.plateId, inputHash: claim.job.inputHash },
    ...(claim.job.stage ? { stage: claim.job.stage } : {}),
    ...(claim.job.groupScope ? { groupScope: claim.job.groupScope } : {}),
    ...(claim.job.standardId ? { standardId: claim.job.standardId } : {}),
    ...(claim.job.localScope ? { local: true } : {}),
    ...(claim.job.queueRunId ? { queueRunId: claim.job.queueRunId } : {}),
    ...(claim.job.stageOptions ? { stageOptions: claim.job.stageOptions } : {}),
    claimId: claim.claimId,
    leaseExpiresAt: new Date(claim.leaseExpiresAt).toISOString(),
    ...(claim.job.stage === 'research' && claim.job.researchModel?.executor === 'desktop' ? { model: claim.job.researchModel.model } : taggingModel(claim.job.modelId)?.runsOn === 'desktop' ? { model: taggingModel(claim.job.modelId)!.model } : {}),
    plate: { id: plate.id, state: plate.state, displayName: plate.displayName, image: plate.image, tags: plate.tags ?? [],
      ...(claim.job.localScope && typeof plate.imageUrl === 'string' ? { imageUrl: plate.imageUrl } : {}),
      ...(claim.job.stage ? { description: plate.description ?? null, sourceUrl: plate.sourceUrl ?? null, wikiUrl: plate.wikiUrl ?? null } : {}),
      ...(claim.job.stage === 'research' ? { funFacts: plate.funFacts ?? [], readMore: plate.readMore ?? [], firstIssuedYear: plate.firstIssuedYear ?? null } : {}),
    },
  })
}

/** Reconstruct plate input for older jobs that predate stored input snapshots. */
async function legacyInput(batchId: string, plateId: string): Promise<Plate> {
  const review = reviewDeps()
  const baseline = await review.baseline(plateId)
  if (!baseline) throw Error('Job input is unavailable')
  const edit = await review.store.getEdit(batchId, plateId)
  return { ...baseline, ...edit?.fields }
}
