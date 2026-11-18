import type { Firestore, Transaction } from '@google-cloud/firestore'

export async function hasActivePipeline(db: Firestore, tx: Transaction, env: string): Promise<boolean> {
  // Legacy worker records use device namespaces, so the Batch owns catalog membership.
  const batches = await tx.get(db.collection('reviewBatches').where('env', '==', env).select())
  const batchIds = batches.docs.map(batch => batch.id)
  for (let offset = 0; offset < batchIds.length; offset += 30) {
    const ids = batchIds.slice(offset, offset + 30)
    const [runs, jobs] = await Promise.all([
      tx.get(db.collection('localPipelineRuns').where('batchId', 'in', ids).select('status')),
      tx.get(db.collection('jobs').where('batchId', 'in', ids).select('state', 'queueRunId')),
    ])
    // Queue jobs are represented by their parent run until incremental writes settle.
    if (runs.docs.some(run => ['queued', 'running'].includes(run.get('status'))) ||
      jobs.docs.some(job => !job.get('queueRunId') && ['queued', 'claimed'].includes(job.get('state')))) return true
  }
  return false
}

export async function canQueueDuringPublish(db: Firestore, tx: Transaction, env: string): Promise<boolean> {
  const lock = await tx.get(db.doc('locks/publish'))
  return lock.get('env') !== env || lock.get('purpose') === 'abandon' ||
    !(Date.parse(lock.get('expiresAt')) > Date.now())
}
