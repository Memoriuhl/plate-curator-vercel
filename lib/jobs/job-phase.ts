import type { JobsDeps, Outcome, PipelineStage } from './types'

export const jobPhaseCounts = { research: 3, 'enhance-image': 2 } as const

export function normalizeSkippedPhases(
  value: unknown,
  stage?: PipelineStage
): number[] | null | undefined {
  if (value === undefined) return undefined
  if (
    stage !== 'research' ||
    !Array.isArray(value) ||
    value.length > 2 ||
    value.some((index) => index !== 0 && index !== 1)
  )
    return null
  return [0, 1].filter((index) => value.includes(index))
}

export async function reportJobPhase(
  d: JobsDeps,
  workerId: string,
  id: string,
  claimId: string,
  index: number,
  skips?: unknown
): Promise<Outcome<null>> {
  if (!d.localScope) return { ok: false, error: 'forbidden' }
  return d.store.transaction(async (tx) => {
    const job = await tx.get(id)
    if (!job || job.localScope !== d.localScope || !job.queueRunId)
      return { ok: false, error: 'not_found' }
    if (job.claimId !== claimId || job.workerId !== workerId)
      return { ok: false, error: 'claim_mismatch' }
    if (
      job.state !== 'claimed' ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= d.now()
    )
      return { ok: false, error: 'claim_expired' }
    const count =
      job.stage && Object.hasOwn(jobPhaseCounts, job.stage)
        ? jobPhaseCounts[job.stage as keyof typeof jobPhaseCounts]
        : 0
    if (!Number.isInteger(index) || index < 0 || index >= count)
      return { ok: false, error: 'invalid_result' }
    const reported = normalizeSkippedPhases(skips, job.stage)
    if (reported === null || reported?.some((phase) => phase >= index))
      return { ok: false, error: 'invalid_result' }
    const skippedPhases = [
      ...new Set([...(job.skippedPhases ?? []), ...(reported ?? [])]),
    ].sort()
    if (
      index > (job.phaseIndex ?? 0) ||
      skippedPhases.length > (job.skippedPhases?.length ?? 0)
    ) {
      tx.set({
        ...job,
        phaseIndex: Math.max(index, job.phaseIndex ?? 0),
        ...(skippedPhases.length ? { skippedPhases } : {}),
      })
    }
    return { ok: true, value: null }
  })
}
