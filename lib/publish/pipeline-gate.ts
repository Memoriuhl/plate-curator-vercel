import type { Firestore, Transaction } from '@google-cloud/firestore'

export async function hasActivePipeline(db: Firestore, tx: Transaction, env: string): Promise<boolean> {
  const [runs, jobs] = await Promise.all([
    tx.get(db.collection('localPipelineRuns').where('status', 'in', ['queued', 'running']).select('batchId')),
    tx.get(db.collection('jobs').where('state', 'in', ['queued', 'claimed']).select('batchId', 'queueRunId')),
  ])
  // Queue jobs are represented by their parent run, including while their draft writes settle.
  const batchIds = new Set([...runs.docs, ...jobs.docs.filter(job => !job.get('queueRunId'))]
    .map(doc => doc.get('batchId'))
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && !id.includes('/')))
  if (!batchIds.size) return false
  const batches = await tx.getAll(...Array.from(batchIds, id => db.doc(`reviewBatches/${id}`)), { fieldMask: ['env'] })
  return batches.some(batch => batch.get('env') === env)
}

export async function canQueueDuringPublish(db: Firestore, tx: Transaction, env: string): Promise<boolean> {
  const lock = await tx.get(db.doc('locks/publish'))
  return lock.get('env') !== env || lock.get('purpose') === 'abandon' ||
    !(Date.parse(lock.get('expiresAt')) > Date.now())
}
