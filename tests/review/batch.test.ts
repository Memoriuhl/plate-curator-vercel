import { createMemoryStore } from '../../lib/review/memory-store'
import { reviewBatchScenarios } from './batch-scenarios'
import { expect, test } from 'vitest'
import { batch, command } from '../publish/fixture'

reviewBatchScenarios(batch => createMemoryStore([batch]))

test('Publish metadata uses the memory store without changing the Batch revision signal', async () => {
  const store = createMemoryStore([batch])
  expect(await store.updatePublishMetadata(batch.id, 2, { publishCommand: { commandId: command.commandId, revision: 2 }, approvalRun: { runId: 'retry-run', revision: 1 }, publishRequestedBy: command.requestedBy })).toBe(true)
  expect(await store.getBatch(batch.id)).toMatchObject({ revision: 2, approvalRun: { runId: 'retry-run' }, publishCommand: { commandId: command.commandId } })
  expect(store.signalRevision(batch.id)).toBe(2)
  expect(await store.updatePublishMetadata(batch.id, 1, { approvalRun: { runId: 'stale-run', revision: 0 } })).toBe(false)
})
