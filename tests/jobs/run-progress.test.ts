import { expect, test } from 'vitest'
import { formatDuration, queueProgress, stageStatus } from '../../lib/jobs/run-progress'
import { workflowVisibilityUrl } from '../../lib/jobs/workflow-visibility'
import type { QueueRunView } from '../../lib/jobs/queue-types'

function run(): QueueRunView {
  return { id: 'run', requestId: 'request', fingerprint: 'hash', requestedBy: 'user', batchId: 'batch', env: 'development', localScope: 'test', plateIds: ['AK.one'], stages: ['wiki-link', 'describe', 'story'], options: {}, previewOnly: false, createdAt: 100, queuedAt: 100, enqueueSequence: 1, updatedAt: 33100, status: 'failed', resourceClass: 'io', editable: true, applied: false,
    attempts: [{ number: 1, requestId: 'request', createdAt: 100, status: 'failed', endedAt: 33100, cursor: 0, jobIds: ['wiki'], completedJobIds: [], choices: {}, error: 'no_sources', steps: [
      { index: 0, stage: 'wiki-link', plateId: 'AK.one', resourceClass: 'io' },
      { index: 1, stage: 'describe', plateId: 'AK.one', resourceClass: 'gpu' },
      { index: 2, stage: 'story', plateId: 'AK.one', resourceClass: 'gpu' },
    ] }], jobs: [{ id: 'wiki', plateId: 'AK.one', batchId: 'batch', requestedBy: 'user', env: 'development', inputHash: 'hash', state: 'completed', queueAttempt: 1, queueStep: 0, createdAt: 100, completedAt: 33100, workerId: 'PC', result: { stageError: 'no_sources', durationMs: 33000, suggestions: [], backend: 'local', model: 'none', promptVersion: 'v1' } }] }
}

test('legacy failed runs report cancelled dependants and never call no-source completion a success', () => {
  const progress = queueProgress(run())
  expect(progress.steps.map(step => step.status)).toEqual(['failed', 'cancelled', 'cancelled'])
  expect(progress.steps[0].durationMs).toBe(33000)
  expect(progress.workerIds).toEqual(['PC'])
  expect(formatDuration(progress.steps[0].durationMs)).toBe('00:33')
  expect(formatDuration(undefined)).toBe('—')
})

test('retry counts inherited completed jobs but not failed jobs from previous attempts', () => {
  const source = run()
  source.status = 'queued'
  source.attempts.push({ ...source.attempts[0], number: 2, cursor: 1, status: 'queued', endedAt: undefined, completedJobIds: ['wiki'] })
  delete source.jobs[0].result!.stageError
  const progress = queueProgress(source)
  expect(progress.steps.map(step => step.status)).toEqual(['completed', 'queued', 'queued'])
  expect(progress.workerIds).toEqual([])
})

test('multi-plate stage aggregation preserves failures, cancellation and skipped stages', () => {
  const steps = queueProgress(run()).steps
  expect(stageStatus(steps)).toBe('failed')
  expect(stageStatus(steps.slice(1))).toBe('cancelled')
  expect(stageStatus([])).toBe('skipped')
})

test('workflow links target the official run-specific Visibility UI with the correct environment', () => {
  expect(workflowVisibilityUrl('wrun_abc', 'preview')).toBe('https://vercel.com/memoriuhl/plate-curator-vercel/workflows/runs/wrun_abc?environment=preview')
  expect(workflowVisibilityUrl('wrun_abc', 'production')).toContain('environment=production')
  expect(workflowVisibilityUrl('a/b?c', 'preview')).toContain('a%2Fb%3Fc')
  expect(workflowVisibilityUrl(undefined, 'preview')).toBeNull()
  expect(workflowVisibilityUrl('local-run', 'development')).toBeNull()
  expect(workflowVisibilityUrl('wrun_abc', 'preview', 'local', '3456')).toBe('http://localhost:3456/run/wrun_abc')
  expect(workflowVisibilityUrl('wrun_abc', 'preview', 'local', '3457')).toBe('http://localhost:3457/run/wrun_abc')
  expect(workflowVisibilityUrl('wrun_abc', 'preview', 'local', 'abc')).toBe('http://localhost:3456/run/wrun_abc')
})
