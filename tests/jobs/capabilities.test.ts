import { afterEach, expect, test, vi } from 'vitest'
import { createMemoryStore } from '../../lib/review/memory-store'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { parseWorkerCapabilities, readLocalWorkerCapabilities, reportLocalWorkerCapabilities, type LocalWorkerCapabilities } from '../../lib/jobs/capabilities'
import { withCapabilityHeartbeat } from '../../worker/capability-heartbeat'
import type { JobsDeps } from '../../lib/jobs/types'

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })
const capabilities: LocalWorkerCapabilities = { group: { available: true }, embeddings: { available: true }, mask: { available: true }, vision: { available: false, reason: 'No local vision service' }, pollIntervalMs: 5000 }

test('worker reports are scoped, timestamped by the server and expire after two polls', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  let now = 1000
  const d: JobsDeps = { store: createMemoryJobsStore(createMemoryStore([]), 'development'), /** Simulate an absent plate in the catalog baseline for this case. */ baseline: async () => null, /** Read the controlled test clock so state and lease timestamps advance deterministically. */ now: () => now, /** Supply a deterministic ID so the test can identify the generated record. */ id: () => 'claim', leaseMs: 1000, localScope: 'scope' }
  expect((await readLocalWorkerCapabilities(d)).group).toEqual({ available: false, reason: 'Local worker not reporting' })
  expect(await reportLocalWorkerCapabilities(d, 'worker', capabilities)).toBe(true)
  expect((await readLocalWorkerCapabilities(d)).group.available).toBe(true)
  expect((await readLocalWorkerCapabilities({ ...d, localScope: 'other' })).group.available).toBe(false)
  now = 11000
  expect((await readLocalWorkerCapabilities(d)).group.available).toBe(true)
  now++
  expect((await readLocalWorkerCapabilities(d)).group.reason).toBe('Local worker not reporting')
  await reportLocalWorkerCapabilities(d, 'worker', capabilities)
  expect((await readLocalWorkerCapabilities(d)).group.available).toBe(true)
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  expect(await reportLocalWorkerCapabilities(d, 'worker', capabilities)).toBe(false)
  expect((await readLocalWorkerCapabilities(d)).group.available).toBe(false)
  expect(parseWorkerCapabilities({ ...capabilities, reportedAt: 999999999 })).toBeNull()
  expect(parseWorkerCapabilities({ ...capabilities, pollIntervalMs: 0 })).toBeNull()
})

test('unchanged memory reports retain their timestamp until the next poll interval', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  let now = 1000
  const d: JobsDeps = { store: createMemoryJobsStore(createMemoryStore([]), 'development'), /** Simulate an absent plate in the catalog baseline for this case. */ baseline: async () => null, /** Read the controlled test clock so state and lease timestamps advance deterministically. */ now: () => now, /** Supply a deterministic ID so the test can identify the generated record. */ id: () => 'claim', leaseMs: 1000, localScope: 'scope' }
  await reportLocalWorkerCapabilities(d, 'worker', capabilities)
  now = 5999
  expect(await reportLocalWorkerCapabilities(d, 'worker', capabilities)).toBe(true)
  expect((await readLocalWorkerCapabilities(d)).reportedAt).toBe(1000)
  now++
  await reportLocalWorkerCapabilities(d, 'worker', capabilities)
  expect((await readLocalWorkerCapabilities(d)).reportedAt).toBe(6000)
})

test('long inference sends bounded heartbeats and stops its timer on completion', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  vi.stubEnv('LOCAL_PIPELINE_SCOPE', 'scope')
  vi.useFakeTimers()
  let finish!: () => void
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }))
  const running = withCapabilityHeartbeat({ capabilities, apiBase: 'http://localhost:3302', token: 'fixture', fetch: request, log: vi.fn() }, () => new Promise<void>(resolve => { finish = resolve }))
  await vi.advanceTimersByTimeAsync(130000)
  expect(request).toHaveBeenCalledTimes(26)
  expect(request.mock.calls[0][0]).toBe('http://localhost:3302/api/worker/capabilities')
  expect(request.mock.calls.every(([url]) => String(url).endsWith('/api/worker/capabilities'))).toBe(true)
  finish()
  await running
  await vi.advanceTimersByTimeAsync(20000)
  expect(request).toHaveBeenCalledTimes(26)
})

test('the production worker never sends capability heartbeats', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  vi.useFakeTimers()
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }))
  await withCapabilityHeartbeat({ capabilities, apiBase: 'http://localhost:3302', token: 'fixture', fetch: request, log: vi.fn() }, async () => { await vi.advanceTimersByTimeAsync(20000) })
  expect(request).not.toHaveBeenCalled()
})
