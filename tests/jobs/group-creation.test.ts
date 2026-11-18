import { afterEach, expect, test, vi } from 'vitest'
import { createJob, getJob } from '../../lib/jobs/jobs'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { plateRevision } from '../../lib/review/revision'
import { groupProposal } from '../../worker/image-group'
import type { JobsDeps } from '../../lib/jobs/types'

afterEach(() => vi.unstubAllEnvs())

/**
 * Create a scoped grouping fixture with baseline plates and a partial selection to
 * validate completeness.
 */
function setup() {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const plates = ['a', 'b', 'c'].map(id => ({ id: `AK.${id}`, state: 'AK', slug: id, displayName: id, image: `${id}.webp`, tags: [], templateFamily: `AK.${id}`, templateRole: 'template' as const, isStandard: id === 'b' }))
  const review = createMemoryStore([{ id: 'batch', name: 'Group', createdBy: 'editor', createdAt: '', state: 'open', revision: 0, baselineVersion: 1, approval: null, plateIds: plates.slice(0, 2).map(plate => plate.id), stateOrders: { AK: plates.map(plate => plate.id) } }])
  const deps: JobsDeps = { store: createMemoryJobsStore(review, 'development'), /** Resolve the plate by ID from the fixture baseline. */ baseline: async id => plates.find(plate => plate.id === id) ?? null, /** Return the fixture state order used by the review or queue operation. */ stateBaseline: async () => plates, /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () => 0, /** Supply a deterministic ID so the test can identify the generated record. */ id: () => 'claim', leaseMs: 1000, localScope: 'scope' }
  const groupScope = plates.slice(0, 2).map(plate => ({ plate: { ...plate, displayName: 'Forged client object', image: 'forged.webp' }, baseRevision: plateRevision(plate) }))
  const input = { id: 'group', batchId: 'batch', plateId: plates[0].id, requestedBy: 'editor', stage: 'group' as const, groupScope }
  return { plates, deps, input }
}

test('Group creation reconstructs trusted scope and order[0] anchor instead of storing caller plates', async () => {
  const s = setup()
  const created = await createJob(s.deps, s.input)
  expect(created).toMatchObject({ ok: true, value: { standardId: 'AK.a', groupScope: [{ plate: { displayName: 'a', image: 'a.webp' } }, { plate: { displayName: 'b', image: 'b.webp' } }] } })
  if (!created.ok) throw Error('Expected group job')
  const suggestion = groupProposal(created.value.groupScope!, { model: 'fixture', groups: [{ templateId: 'AK.b', variants: [{ id: 'AK.a' }] }], similarities: [] }, created.value.standardId)
  expect(suggestion?.proposals.find(value => value.plateId === 'AK.a')?.fields.templateRole).toBe('template')
  expect(suggestion?.proposals.find(value => value.plateId === 'AK.b')?.fields.variantOfPlateId).toBe('AK.a')
})

test('Group creation rejects nonmembers, stale scope and omitted family siblings before storing a job', async () => {
  const s = setup()
  const nonmember = { plate: s.plates[2], baseRevision: plateRevision(s.plates[2]) }
  expect(await createJob(s.deps, { ...s.input, groupScope: [s.input.groupScope[0], nonmember] })).toMatchObject({ error: 'forbidden' })
  expect(await createJob(s.deps, { ...s.input, groupScope: s.input.groupScope.map(member => ({ ...member, baseRevision: 'stale' })) })).toMatchObject({ error: 'stale_input' })
  s.plates[2].templateFamily = 'AK.a'
  expect(await createJob(s.deps, s.input)).toMatchObject({ error: 'forbidden' })
  expect(await getJob(s.deps, 'group')).toBeNull()
})
