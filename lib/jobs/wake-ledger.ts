/**
 * The wake ledger records, per pipeline run, which job transition its workflow was last
 * woken for. The claim, report and fail routes and the pipeline list all wake the
 * workflow after a job changes. The ledger lets exactly one of them send each wake, and
 * lets another sender take over when that one failed or went quiet.
 */
export type WakeRecord = {
  /** The job transition, from `wakeKey`. */
  key: string
  state: 'sending' | 'delivered' | 'failed'
  /** While `sending`, other senders leave the wake alone until this time. */
  until: number
}

/** Decide whether a sender may take the wake for `key`, given the stored record. */
export function mayClaimWake(
  record: WakeRecord | null,
  key: string,
  now: number
): boolean {
  if (!record || record.key !== key) return true
  if (record.state === 'delivered') return false
  if (record.state === 'sending') return now >= record.until
  return true
}

/** Identify a job transition by run, attempt, step, job, state, claim and time. */
export function wakeKey(job: {
  id: string
  queueRunId?: string
  queueAttempt?: number
  queueStep?: number
  state: string
  claimId?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  expiredAt?: number
  endedAt?: number
}): string {
  return [
    job.queueRunId,
    job.queueAttempt,
    job.queueStep,
    job.id,
    job.state,
    job.claimId ?? '',
    job.completedAt ??
      job.expiredAt ??
      job.endedAt ??
      job.startedAt ??
      job.createdAt,
  ].join(':')
}
