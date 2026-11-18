import { assertStagingProject } from './demo-seed'

export type BatchSignalsBackfillStore = {
  listBatchIds(env: string): Promise<string[]>
  initializeMissing(batchId: string, env: string): Promise<boolean>
}

/**
 * Initialize missing live revision signals for staging batches and report how many were
 * created.
 */
export async function backfillBatchSignals(
  store: BatchSignalsBackfillStore,
  input: { projectId: string | undefined; env: string }
) {
  assertStagingProject(input.projectId)
  const ids = await store.listBatchIds(input.env)
  let initialized = 0
  for (const id of ids)
    if (await store.initializeMissing(id, input.env)) initialized += 1
  return { scanned: ids.length, initialized }
}
