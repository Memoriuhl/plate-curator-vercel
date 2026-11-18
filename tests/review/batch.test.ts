import { createMemoryStore } from '../../lib/review/memory-store'
import { reviewBatchScenarios } from './batch-scenarios'
import { expect, test } from 'vitest'
import { batch, command, fixture, owner, snapshot } from '../publish/fixture'
import { approveBatch, proposeEdit, submitBatch } from '../../lib/review/batch'
import { plateRevision } from '../../lib/review/revision'

reviewBatchScenarios((batch) => createMemoryStore([batch]))

test('Publish metadata uses the memory store without changing the Batch revision signal', async () => {
  const store = createMemoryStore([batch])
  expect(
    await store.updatePublishMetadata(batch.id, 2, {
      publishCommand: { commandId: command.commandId, revision: 2 },
      approvalRun: { runId: 'retry-run', revision: 1 },
      publishRequestedBy: command.requestedBy,
    })
  ).toBe(true)
  expect(await store.getBatch(batch.id)).toMatchObject({
    revision: 2,
    approvalRun: { runId: 'retry-run' },
    publishCommand: { commandId: command.commandId },
  })
  expect(store.signalRevision(batch.id)).toBe(2)
  expect(
    await store.updatePublishMetadata(batch.id, 1, {
      approvalRun: { runId: 'stale-run', revision: 0 },
    })
  ).toBe(false)
})

test('last-changed follows persisted draft edits and survives submission and approval', async () => {
  const editor = {
    uid: batch.createdBy,
    name: 'Editor',
    role: 'editor',
  } as const
  const { deps } = fixture({
    ...batch,
    state: 'open',
    revision: 0,
    approval: null,
  })
  const changedAt = '2026-11-16T12:00:00Z'
  deps.now = () => changedAt
  const plate = snapshot.plates[0]
  expect(
    await proposeEdit(deps, editor, {
      batchId: batch.id,
      plateId: plate.id,
      baseRevision: plateRevision(plate),
      fields: { tags: ['updated'] },
    })
  ).toMatchObject({ ok: true, value: { batch: { lastChangedAt: changedAt } } })

  deps.now = () => '2026-11-17T12:00:00Z'
  expect(await submitBatch(deps, editor, batch.id, 1)).toMatchObject({
    ok: true,
  })
  expect(await approveBatch(deps, owner, batch.id, 2)).toMatchObject({
    ok: true,
  })
  expect(await deps.store.getBatch(batch.id)).toMatchObject({
    state: 'approved',
    lastChangedAt: changedAt,
  })
})
