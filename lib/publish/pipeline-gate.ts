import type { Firestore, Transaction } from '@google-cloud/firestore'

/**
 * Count live pipeline work attached to batches in the review environment: queued or
 * running runs, plus queued or claimed jobs that no run represents. With `stopAtFirst`
 * the count stops at one, which is all the publish gate needs.
 */
export async function countActivePipeline(
  db: Firestore,
  tx: Transaction,
  env: string,
  stopAtFirst = false
): Promise<number> {
  // Legacy worker records use device namespaces, so the Batch owns catalog membership.
  const batches = await tx.get(
    db.collection('reviewBatches').where('env', '==', env).select()
  )
  const batchIds = batches.docs.map((batch) => batch.id)
  let count = 0
  for (let offset = 0; offset < batchIds.length; offset += 30) {
    const ids = batchIds.slice(offset, offset + 30)
    const [runs, jobs] = await Promise.all([
      tx.get(
        db
          .collection('localPipelineRuns')
          .where('batchId', 'in', ids)
          .select('status')
      ),
      tx.get(
        db
          .collection('jobs')
          .where('batchId', 'in', ids)
          .select('state', 'queueRunId')
      ),
    ])
    // Queue jobs are represented by their parent run until incremental writes settle.
    count +=
      runs.docs.filter((run) =>
        ['queued', 'running'].includes(run.get('status'))
      ).length +
      jobs.docs.filter(
        (job) =>
          !job.get('queueRunId') &&
          ['queued', 'claimed'].includes(job.get('state'))
      ).length
    if (stopAtFirst && count > 0) return count
  }
  return count
}

/**
 * Check for live jobs attached to batches in the review environment before taking the
 * publish lock.
 */
export async function hasActivePipeline(
  db: Firestore,
  tx: Transaction,
  env: string
): Promise<boolean> {
  return (await countActivePipeline(db, tx, env, true)) > 0
}

/**
 * Allow queue creation only when there is no active publish lock in the review
 * environment.
 */
export async function canQueueDuringPublish(
  db: Firestore,
  tx: Transaction,
  env: string
): Promise<boolean> {
  const lock = await tx.get(db.doc('locks/publish'))
  return (
    lock.get('env') !== env ||
    lock.get('purpose') === 'abandon' ||
    !(Date.parse(lock.get('expiresAt')) > Date.now())
  )
}
