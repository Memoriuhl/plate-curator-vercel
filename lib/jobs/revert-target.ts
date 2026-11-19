import type { RunAttempt } from './queue-types'

/** Identify the exact attempt and jobs shown when a curator opened Revert. */
export type RunRevertTarget = { attempt: number; jobIds: string[] }

export function runRevertTarget(
  attempt: Pick<RunAttempt, 'number' | 'jobIds'>
): RunRevertTarget {
  return { attempt: attempt.number, jobIds: attempt.jobIds }
}
