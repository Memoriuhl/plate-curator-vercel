import type { JobsDeps, Outcome } from './types'

export const jobPhaseCounts = { research: 3, 'enhance-image': 2 } as const

export async function reportJobPhase(d: JobsDeps, workerId: string, id: string, claimId: string, index: number): Promise<Outcome<null>> {
  if (!d.localScope) return { ok: false, error: 'forbidden' }
  return d.store.transaction(async tx => {
    const job = await tx.get(id)
    if (!job || job.localScope !== d.localScope || !job.queueRunId) return { ok: false, error: 'not_found' }
    if (job.claimId !== claimId || job.workerId !== workerId) return { ok: false, error: 'claim_mismatch' }
    if (job.state !== 'claimed' || !job.leaseExpiresAt || job.leaseExpiresAt <= d.now()) return { ok: false, error: 'claim_expired' }
    const count = job.stage && Object.hasOwn(jobPhaseCounts, job.stage) ? jobPhaseCounts[job.stage as keyof typeof jobPhaseCounts] : 0
    if (!Number.isInteger(index) || index < 0 || index >= count) return { ok: false, error: 'invalid_result' }
    if (index > (job.phaseIndex ?? 0)) tx.set({ ...job, phaseIndex: index })
    return { ok: true, value: null }
  })
}
