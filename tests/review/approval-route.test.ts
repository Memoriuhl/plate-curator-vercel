import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  GET as preflight,
  POST as publish,
} from '../../app/api/batches/[id]/publish/route'
import { GET } from '../../app/api/batches/[id]/run/route'
import { PATCH } from '../../app/api/batches/[id]/plates/[plateId]/route'
import { POST as keepDraftValues } from '../../app/api/batches/[id]/conflicts/route'
import { createMemoryStore } from '../../lib/review/memory-store'
import { sharedDraftId } from '../../lib/review/draft-id'
import { reviewEnv } from '../../lib/server/context'
import { plateRevision } from '../../lib/review/revision'
import { HookConflictError, HookNotFoundError } from 'workflow/errors'
import type { ReviewBatch, ReviewDeps } from '../../lib/review/types'

const mocks = vi.hoisted(() => ({
  currentActor: vi.fn(),
  currentActiveOwner: vi.fn(),
  reviewDeps: vi.fn(),
  publishDeps: vi.fn(),
  publishAllowed: vi.fn(() => true),
  controlRead: vi.fn(),
  start: vi.fn(),
  getHookByToken: vi.fn(),
  resumeHook: vi.fn(),
  getRun: vi.fn(),
  publishBatch: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
  revalidateTag: vi.fn(),
}))
vi.mock('../../lib/server/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/server/context')>()),
  ...mocks,
}))
vi.mock('workflow/api', () => mocks)
vi.mock('../../lib/publish/publish', () => ({
  publishBatch: mocks.publishBatch,
}))
const ctx = { params: Promise.resolve({ id: 'batch' }) }
const baseline = {
  id: 'one',
  state: 'AK',
  slug: 'one',
  displayName: 'One',
  image: '',
  tags: [],
  templateRole: 'template' as const,
  isStandard: true,
}
const batch: ReviewBatch = {
  id: 'batch',
  name: 'Review',
  createdBy: 'editor',
  createdByName: null,
  createdAt: '',
  state: 'open',
  revision: 0,
  baselineVersion: 7,
  plateIds: ['one'],
  stateOrders: {},
  approval: null,
}
/** Build the POST request the route fixture passes to its handler. */
function request(body: unknown) {
  return new Request('http://localhost/api/batches/batch', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.publishAllowed.mockReturnValue(true)
  mocks.currentActiveOwner.mockResolvedValue({
    ok: true,
    actor: {
      uid: 'owner',
      email: 'owner@example.com',
      authorityEpoch: 5,
      role: 'owner',
    },
  })
  mocks.controlRead.mockResolvedValue({ paused: false, generation: 1 })
  mocks.publishDeps.mockReturnValue({
    control: { read: mocks.controlRead },
    pointer: { read: async () => ({ version: 7 }) },
    records: {
      eligibility: async () => ({ canRetry: false, reason: 'not_waiting' }),
      command: async () => null,
      get: async () => null,
      accept: async (command: unknown) => ({ ok: true, command }),
      bindRun: async () => true,
    },
  })
  mocks.getHookByToken.mockRejectedValue(new HookNotFoundError('missing'))
  mocks.currentActor.mockResolvedValue({
    ok: true,
    actor: { uid: 'owner', name: null, role: 'owner' },
  })
  mocks.start.mockResolvedValue({ runId: 'run' })
  mocks.resumeHook.mockResolvedValue({ runId: 'run' })
  mocks.getRun.mockReturnValue({ status: Promise.resolve('running') })
  mocks.reviewDeps.mockReturnValue({
    store: createMemoryStore([batch]),
    baselineAtVersion: async () => baseline,
    baseline: async () => baseline,
    stateBaseline: async () => [baseline],
    now: () => '2026-11-16T12:00:00.000Z',
    liveVersion: async () => 7,
  } satisfies ReviewDeps)
})

test('a refused Publish command is not recorded as publishing', async () => {
  mocks.reviewDeps().store = createMemoryStore([
    {
      ...batch,
      state: 'approved',
      approval: { revision: 0, by: 'owner', at: '' },
    },
  ])
  expect((await publish(request({ revision: 0 }), ctx)).status).toBe(409)
  expect(
    (await mocks.reviewDeps().store.getBatch('batch')).publishRequestedAt
  ).toBeUndefined()
})

test('a stopped Publish run starts a new command run', async () => {
  mocks.publishDeps().records.eligibility = async () => ({
    canRetry: true,
    reason: null,
  })
  mocks.reviewDeps().store = createMemoryStore([
    {
      ...batch,
      state: 'approved',
      revision: 2,
      approval: { revision: 1, by: 'owner', at: '' },
      approvalRun: { runId: 'old', revision: 1 },
    },
  ])
  mocks.getRun.mockReturnValue({
    status: Promise.resolve('completed'),
    returnValue: Promise.resolve({
      outcome: 'publish_failed',
      error: 'paused',
    }),
  })
  expect(
    (await publish(request({ revision: 2, commandId: 'fresh-click' }), ctx))
      .status
  ).toBe(202)
  expect(mocks.resumeHook).not.toHaveBeenCalled()
  expect(mocks.start).toHaveBeenCalledWith(
    expect.any(Function),
    ['batch', 2, expect.objectContaining({ commandId: 'fresh-click' })],
    expect.objectContaining({
      experimental_hook: {
        token: 'publish-command:fresh-click',
        experimental_minRetention: '30d',
      },
    })
  )
})

test('duplicate fresh requests return their persisted run even after the Batch published', async () => {
  const command = {
    batchId: 'batch',
    revision: 2,
    commandId: 'fresh-click',
    generation: 1,
    requestedBy: {
      uid: 'owner',
      email: 'owner@example.com',
      authorityEpoch: 5,
    },
  }
  mocks.publishDeps().records.command = async () => ({
    command,
    runId: 'fresh-run',
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await publish(
      request({ revision: 2, commandId: 'fresh-click' }),
      ctx
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      status: 'publishing',
      runId: 'fresh-run',
    })
  }
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.resumeHook).not.toHaveBeenCalled()
})

test('a replayed command cannot be taken by a different requester', async () => {
  mocks.publishDeps().records.command = async () => ({
    command: {
      batchId: 'batch',
      revision: 2,
      requestedBy: {
        uid: 'other',
        email: 'other@example.com',
        authorityEpoch: 0,
      },
    },
    runId: 'other-run',
  })
  expect(
    (await publish(request({ revision: 2, commandId: 'fresh-click' }), ctx))
      .status
  ).toBe(409)
  expect(mocks.start).not.toHaveBeenCalled()
})

test('a concurrent duplicate start returns the run owning the command token', async () => {
  const command = {
    batchId: 'batch',
    revision: 2,
    commandId: 'fresh-click',
    generation: 1,
    requestedBy: {
      uid: 'owner',
      email: 'owner@example.com',
      authorityEpoch: 5,
    },
  }
  mocks.publishDeps().records.command = async () => ({ command })
  mocks.start
    .mockResolvedValueOnce({ runId: 'one-run' })
    .mockRejectedValueOnce(
      new HookConflictError('publish-command:fresh-click', 'one-run')
    )
  const responses = await Promise.all([
    publish(request({ revision: 2, commandId: 'fresh-click' }), ctx),
    publish(request({ revision: 2, commandId: 'fresh-click' }), ctx),
  ])
  for (const response of responses) {
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      status: 'publishing',
      runId: 'one-run',
    })
  }
})

test('unauthenticated fresh clicks are refused before command lookup', async () => {
  mocks.currentActiveOwner.mockResolvedValue({
    ok: false,
    response: Response.json({ error: 'unauthenticated' }, { status: 401 }),
  })
  expect(
    (await publish(request({ revision: 2, commandId: 'fresh-click' }), ctx))
      .status
  ).toBe(401)
  expect(mocks.publishDeps).not.toHaveBeenCalled()
})

test('run read requires the Owner and returns missing batches', async () => {
  mocks.currentActor.mockResolvedValueOnce({
    ok: true,
    actor: { role: 'editor' },
  })
  const forbidden = await GET(request(null), ctx)
  expect(forbidden.status).toBe(403)
  expect(await forbidden.json()).toEqual({ error: 'forbidden' })
  const missing = await GET(request(null), {
    params: Promise.resolve({ id: 'missing' }),
  })
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({ error: 'not_found' })
})

test('run read returns nulls for an unsubmitted batch', async () => {
  expect(await (await GET(request(null), ctx)).json()).toEqual({
    runId: null,
    phase: null,
    outcome: null,
    updatedAt: null,
  })
  expect(mocks.getRun).not.toHaveBeenCalled()
})

test.each(['running', 'completed'])(
  'reads %s runs without waiting on an unfinished result',
  async (status) => {
    mocks.reviewDeps().store = createMemoryStore([
      {
        ...batch,
        state: 'submitted',
        approvalRun: { runId: 'run', revision: 0 },
      },
    ])
    const result = vi.fn(() =>
      Promise.resolve({ outcome: 'published', version: 8 })
    )
    mocks.getRun.mockReturnValue({
      status: Promise.resolve(status),
      createdAt: Promise.resolve(new Date('2026-11-16T12:00:00Z')),
      get returnValue() {
        return result()
      },
    })
    expect(await (await GET(request(null), ctx)).json()).toEqual({
      runId: 'run',
      phase: status === 'completed' ? 'published' : 'waiting-for-approval',
      outcome: status === 'completed' ? { version: 8 } : null,
      updatedAt: '2026-11-16T12:00:00.000Z',
    })
    expect(result).toHaveBeenCalledTimes(status === 'completed' ? 1 : 0)
  }
)

test('run metadata survives a concurrent approval committing a previously read batch', async () => {
  const store = createMemoryStore([
    { ...batch, state: 'submitted', revision: 1 },
  ])
  const before = (await store.getBatch('batch'))!
  expect(await store.recordRun('batch', 1, 'run')).toBe(true)
  await store.commit('batch', 1, {
    batch: {
      ...before,
      state: 'approved',
      revision: 2,
      approval: { revision: 1, by: 'owner', at: '' },
    },
  })
  expect(await store.getBatch('batch')).toMatchObject({
    state: 'approved',
    approvalRun: { runId: 'run', revision: 1 },
  })
  const approved = (await store.getBatch('batch'))!
  expect(await store.requestPublish('batch', 2, 'now')).toBe(true)
  await store.commit('batch', 2, {
    batch: { ...approved, state: 'published', revision: 3 },
  })
  expect(await store.getBatch('batch')).toMatchObject({
    state: 'published',
    approvalRun: { runId: 'run', revision: 1 },
    publishRequestedAt: 'now',
  })
})

test('run metadata writes cannot overwrite edits or a newer submission', async () => {
  const store = createMemoryStore([
    {
      ...batch,
      state: 'submitted',
      revision: 3,
      approvalRun: { runId: 'new', revision: 3 },
    },
  ])
  expect(await store.recordRun('batch', 1, 'old')).toBe(false)
  expect(await store.requestPublish('batch', 2, 'now')).toBe(false)
  expect(await store.getBatch('batch')).toMatchObject({
    state: 'submitted',
    revision: 3,
    approvalRun: { runId: 'new', revision: 3 },
  })
})

test('a stale preflight returns reviewed and live versions without accepting a command', async () => {
  mocks.reviewDeps().store = createMemoryStore([
    { ...batch, state: 'approved', revision: 2 },
  ])
  mocks.publishDeps.mockReturnValue({
    control: { read: mocks.controlRead },
    pointer: { read: async () => ({ version: 8 }) },
    records: { get: async () => null },
  })
  const response = await publish(request({ revision: 2 }), ctx)
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    error: 'stale_baseline',
    reviewedVersion: 7,
    liveVersion: 8,
  })
  expect(mocks.resumeHook).not.toHaveBeenCalled()
  expect(
    (await mocks.reviewDeps().store.getBatch('batch')).publishRequestedAt
  ).toBeUndefined()
})

test('paused wins over stale; Resume restores stale-baseline rejection', async () => {
  mocks.reviewDeps().store = createMemoryStore([
    { ...batch, state: 'approved', revision: 2 },
  ])
  mocks.publishDeps.mockReturnValue({
    control: { read: mocks.controlRead },
    pointer: { read: async () => ({ version: 8 }) },
    records: { get: async () => null },
  })
  mocks.controlRead.mockResolvedValueOnce({ paused: true, generation: 2 })
  expect(await (await publish(request({ revision: 2 }), ctx)).json()).toEqual({
    error: 'paused',
  })
  expect(await (await publish(request({ revision: 2 }), ctx)).json()).toEqual({
    error: 'stale_baseline',
    reviewedVersion: 7,
    liveVersion: 8,
  })
  expect(mocks.resumeHook).not.toHaveBeenCalled()
})

test('missing and unavailable control refuse command acceptance', async () => {
  mocks.reviewDeps().store = createMemoryStore([
    { ...batch, state: 'approved', revision: 2 },
  ])
  mocks.controlRead
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('offline'))
  expect(await (await publish(request({ revision: 2 }), ctx)).json()).toEqual({
    error: 'publish_not_enabled',
  })
  expect((await publish(request({ revision: 2 }), ctx)).status).toBe(503)
  expect(mocks.resumeHook).not.toHaveBeenCalled()
})

test.each(['editor', 'removed', 'bootstrap'])(
  'Publish requires current active membership before reading controls: %s',
  async () => {
    mocks.currentActiveOwner.mockResolvedValue({
      ok: false,
      response: Response.json({ error: 'forbidden' }, { status: 403 }),
    })
    expect((await publish(request({ revision: 2 }), ctx)).status).toBe(403)
    expect(mocks.controlRead).not.toHaveBeenCalled()
    expect(mocks.resumeHook).not.toHaveBeenCalled()
  }
)

test('invalid Publish bodies and missing Batches are rejected before the paused control is read', async () => {
  mocks.controlRead.mockResolvedValue({ paused: true, generation: 2 })
  expect((await publish(request({}), ctx)).status).toBe(400)
  expect(
    (
      await publish(request({ revision: 2 }), {
        params: Promise.resolve({ id: 'missing' }),
      })
    ).status
  ).toBe(404)
  expect(mocks.controlRead).not.toHaveBeenCalled()
})

afterEach(() => vi.unstubAllEnvs())

test('preflight and explicit confirmation target the exact release revision', async () => {
  vi.stubEnv('GCP_PROJECT_ID', 'license-plate-game-staging')
  const requested = {
    ...batch,
    id: 'chosen-batch',
    kind: 'release' as const,
    revision: 2,
  }
  const unrelated = {
    ...batch,
    id: 'other-batch',
    state: 'approved' as const,
    revision: 3,
  }
  mocks.reviewDeps().store = createMemoryStore([requested, unrelated])
  const records = mocks.publishDeps().records
  records.eligibility = vi.fn(async () => ({ canRetry: true, reason: null }))
  const chosen = { params: Promise.resolve({ id: requested.id }) }
  const details = await preflight(request(null), chosen)
  expect(details.status).toBe(200)
  expect(await details.json()).toMatchObject({
    batchRevision: 2,
    confirmation: { revision: 2 },
    destination: 'license-plate-game-staging',
    enabledHere: true,
    canConfirmDraft: true,
  })
  expect(records.eligibility).toHaveBeenCalledWith(
    expect.objectContaining({
      batchId: requested.id,
      revision: 3,
      confirmedDraftRevision: 2,
    }),
    expect.any(String)
  )
  expect(mocks.start).not.toHaveBeenCalled()

  await mocks.reviewDeps().store.commit(requested.id, 2, {
    batch: { ...requested, state: 'open', revision: 3 },
    edit: {
      plateId: 'one',
      fields: { tags: ['changed by Editor'] },
      authorId: 'editor',
      updatedAt: mocks.reviewDeps().now(),
      baseRevision: 'before',
      resultRevision: 'after',
    },
  })
  const stale = await publish(request({ revision: 2 }), chosen)
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({
    error: 'superseded_revision',
    confirmation: { revision: 3 },
  })
  expect(mocks.start).not.toHaveBeenCalled()
  expect(
    (
      await publish(
        request({ revision: 3, commandId: 'confirmed-new' }),
        chosen
      )
    ).status
  ).toBe(202)
  expect(mocks.start).toHaveBeenCalledWith(
    expect.any(Function),
    [requested.id, 4, expect.objectContaining({ confirmedDraftRevision: 3 })],
    expect.any(Object)
  )
  expect(await mocks.reviewDeps().store.getBatch(unrelated.id)).toEqual(
    unrelated
  )
})

test('Publish preflight rejects Editors and missing exact IDs', async () => {
  mocks.currentActiveOwner.mockResolvedValueOnce({
    ok: false,
    response: Response.json({ error: 'forbidden' }, { status: 403 }),
  })
  expect((await preflight(request(null), ctx)).status).toBe(403)
  expect(
    (
      await preflight(request(null), {
        params: Promise.resolve({ id: 'missing' }),
      })
    ).status
  ).toBe(404)
  expect(mocks.publishDeps).not.toHaveBeenCalled()
})

test('Publish preflight reports disabled releases, pending Pipeline, and stale Catalog versions', async () => {
  mocks.reviewDeps().store = createMemoryStore([{ ...batch, kind: 'release' }])
  const records = mocks.publishDeps().records
  records.eligibility = async () => ({ canRetry: true, reason: null })
  mocks.publishAllowed.mockReturnValueOnce(false)
  expect(await (await preflight(request(null), ctx)).json()).toMatchObject({
    enabledHere: false,
    canConfirmDraft: false,
  })
  records.pipelineBusy = async () => true
  expect(await (await preflight(request(null), ctx)).json()).toMatchObject({
    pipelineBusy: true,
    canConfirmDraft: false,
  })
  records.pipelineBusy = async () => false
  mocks.publishDeps().pointer.read = async () => ({ version: 8 })
  expect(await (await preflight(request(null), ctx)).json()).toMatchObject({
    error: 'stale_baseline',
    reviewedVersion: 7,
    liveVersion: 8,
    canConfirmDraft: false,
  })
})

test('Publish preflight exposes the same Standard repair that blocks draft confirmation', async () => {
  const other = {
    ...baseline,
    id: 'other',
    displayName: 'Other',
    isStandard: false,
  }
  const store = createMemoryStore([
    {
      ...batch,
      kind: 'release',
      stateOrders: { AK: [other.id, baseline.id] },
    },
  ])
  mocks.reviewDeps().store = store
  mocks.reviewDeps().stateBaseline = async () => [baseline, other]
  mocks.publishDeps().records.eligibility = async () => ({
    canRetry: true,
    reason: null,
  })
  expect(await (await preflight(request(null), ctx)).json()).toMatchObject({
    canConfirmDraft: false,
    approvalProblems: [expect.stringContaining('make Other the Standard')],
  })
  expect(
    await (await publish(request({ revision: 0 }), ctx)).json()
  ).toMatchObject({
    error: 'standard_change_unconfirmed',
    reasons: [expect.stringContaining('make Other the Standard')],
  })
  expect(mocks.start).not.toHaveBeenCalled()
})

test.each(['open', 'submitted'] as const)(
  'confirming an older %s Batch is retired; only a release from the shared draft publishes',
  async (state) => {
    mocks.reviewDeps().store = createMemoryStore([
      { ...batch, state, revision: 1 },
    ])
    mocks.publishDeps().records.eligibility = async () => ({
      canRetry: true,
      reason: null,
    })
    const response = await publish(request({ revision: 1 }), ctx)
    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({ error: 'batches_retired' })
    expect(await (await preflight(request(null), ctx)).json()).toMatchObject({
      canConfirmDraft: false,
    })
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.resumeHook).not.toHaveBeenCalled()
  }
)

const draftCtx = { params: Promise.resolve({ id: 'draft' }) }
const akOne = {
  id: 'AK.one',
  state: 'AK',
  slug: 'one',
  displayName: 'One',
  image: '',
  tags: [],
}
const akTwo = { ...akOne, id: 'AK.two', slug: 'two', displayName: 'Two' }
const alOne = { ...akOne, id: 'AL.one', state: 'AL' }

/** Point the review fixture at a fresh catalog with two states and no Batches. */
function useDraftFixture() {
  const plates = [akOne, akTwo, alOne]
  const find = async (_version: number, id: string) =>
    plates.find((plate) => plate.id === id) ?? null
  mocks.reviewDeps.mockReturnValue({
    store: createMemoryStore([]),
    baselineAtVersion: find,
    baseline: (id: string) => find(7, id),
    stateBaseline: async (_version: number, state: string) =>
      plates.filter((plate) => plate.state === state),
    now: () => '2026-11-16T12:00:00.000Z',
    liveVersion: async () => 7,
  } satisfies ReviewDeps)
  mocks.publishDeps().records.eligibility = vi.fn(async () => ({
    canRetry: true,
    reason: null,
  }))
}

/** Save one plate's tags in the shared draft through the plate route. */
async function editDraft(plate: typeof akOne, tags: string[], uid = 'owner') {
  mocks.currentActor.mockResolvedValueOnce({
    ok: true,
    actor: { uid, name: uid, role: uid === 'owner' ? 'owner' : 'editor' },
  })
  const response = await PATCH(
    request({ baseRevision: plateRevision(plate), fields: { tags } }),
    { params: Promise.resolve({ id: 'draft', plateId: plate.id }) }
  )
  expect(response.status).toBe(200)
}

test('the Publish view shows the draft revision and what each state changes, with who contributed', async () => {
  useDraftFixture()
  await editDraft(akOne, ['first'], 'editor')
  await editDraft(alOne, ['second'], 'other-editor')
  const view = await preflight(request(null), draftCtx)
  expect(view.status).toBe(200)
  expect(await view.json()).toMatchObject({
    draftId: sharedDraftId(reviewEnv()),
    draftRevision: 2,
    baselineVersion: 7,
    states: [
      { state: 'AK', plates: 1, moved: 0, contributors: ['editor'] },
      { state: 'AL', plates: 1, moved: 0, contributors: ['other-editor'] },
    ],
    pipeline: { busy: false },
    canPublish: true,
  })
})

test('Publish is blocked while pipeline runs remain, and the view and refusal say how many', async () => {
  useDraftFixture()
  await editDraft(akOne, ['first'])
  const records = mocks.publishDeps().records
  records.pipelineBusy = async () => true
  records.activePipelineRuns = async () => 3
  expect(await (await preflight(request(null), draftCtx)).json()).toMatchObject(
    {
      pipeline: { busy: true, activeRuns: 3 },
      canPublish: false,
    }
  )
  const refused = await publish(request({ revision: 1 }), draftCtx)
  expect(refused.status).toBe(409)
  expect(await refused.json()).toEqual({
    error: 'pipeline_busy',
    activeRuns: 3,
  })
  expect(mocks.start).not.toHaveBeenCalled()
})

test('publishing revision N ships N and leaves later edits in the draft', async () => {
  useDraftFixture()
  await editDraft(akOne, ['reviewed'])
  await editDraft(alOne, ['after review'])
  const response = await publish(
    request({ revision: 1, commandId: 'publish-one' }),
    draftCtx
  )
  expect(response.status).toBe(202)
  const [[, [releaseId, revision, command]]] = mocks.start.mock.calls
  expect(revision).toBe(1)
  expect(command).toMatchObject({
    batchId: releaseId,
    confirmedDraftRevision: 0,
    commandId: 'publish-one',
  })
  const store = mocks.reviewDeps().store
  const release = await store.readBatch(releaseId)
  expect(release.batch).toMatchObject({
    kind: 'release',
    source: { batchId: sharedDraftId(reviewEnv()), revision: 1 },
  })
  expect(
    release.edits.map((edit: { plateId: string }) => edit.plateId)
  ).toEqual(['AK.one'])
  const draft = await store.readBatch(sharedDraftId(reviewEnv()))
  expect(draft.batch.revision).toBe(2)
  expect(
    draft.edits.map((edit: { plateId: string }) => edit.plateId).sort()
  ).toEqual(['AK.one', 'AL.one'])
})

test('conflicts from an outside catalog change block Publish until the Owner keeps the draft values', async () => {
  useDraftFixture()
  await editDraft(akOne, ['reviewed'])
  const store = mocks.reviewDeps().store
  const id = sharedDraftId(reviewEnv())
  const head = (await store.getBatch(id))!
  const conflicts = [
    {
      kind: 'field' as const,
      plateId: 'AK.one',
      field: 'tags',
      fromVersion: 6,
      toVersion: 7,
    },
  ]
  expect(
    await store.commit(id, head.revision, {
      batch: { ...head, revision: head.revision + 1, conflicts },
      history: false,
    })
  ).toBe('ok')
  expect(await (await preflight(request(null), draftCtx)).json()).toMatchObject(
    { draftRevision: 2, conflicts, canPublish: false }
  )
  const refused = await publish(
    request({ revision: 2, commandId: 'over-conflicts' }),
    draftCtx
  )
  expect(refused.status).toBe(409)
  expect(await refused.json()).toMatchObject({ error: 'draft_conflicts' })
  expect(mocks.start).not.toHaveBeenCalled()

  mocks.currentActiveOwner.mockResolvedValueOnce({
    ok: false,
    response: Response.json({ error: 'forbidden' }, { status: 403 }),
  })
  expect(
    (await keepDraftValues(request({ revision: 2 }), draftCtx)).status
  ).toBe(403)
  // The Owner keeps the values only for the revision they were shown.
  expect(
    (await keepDraftValues(request({ revision: 1 }), draftCtx)).status
  ).toBe(409)
  expect(
    (await keepDraftValues(request({ revision: 2 }), draftCtx)).status
  ).toBe(200)
  expect(await (await preflight(request(null), draftCtx)).json()).toMatchObject(
    { draftRevision: 3, conflicts: [], canPublish: true }
  )
})

test('a retried Publish click resumes the same release; another requester or revision cannot take it', async () => {
  useDraftFixture()
  await editDraft(akOne, ['reviewed'])
  expect(
    (await publish(request({ revision: 1, commandId: 'click' }), draftCtx))
      .status
  ).toBe(202)
  const [[, [releaseId, , command]]] = mocks.start.mock.calls
  const accepted = { ...command }
  delete accepted.ownerUid
  mocks.publishDeps().records.command = async () => ({
    command: accepted,
    runId: 'first-run',
  })
  const retried = await publish(
    request({ revision: 1, commandId: 'click' }),
    draftCtx
  )
  expect(await retried.json()).toEqual({
    status: 'publishing',
    runId: 'first-run',
  })
  expect(
    (await publish(request({ revision: 2, commandId: 'click' }), draftCtx))
      .status
  ).toBe(409)
  mocks.publishDeps().records.command = async () => ({
    command: {
      ...accepted,
      requestedBy: { uid: 'other', email: 'o@example.com', authorityEpoch: 0 },
    },
    runId: 'first-run',
  })
  expect(
    (await publish(request({ revision: 1, commandId: 'click' }), draftCtx))
      .status
  ).toBe(409)
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(accepted.batchId).toBe(releaseId)
})

test('an empty draft or a revision the draft has not reached cannot be published', async () => {
  useDraftFixture()
  const empty = await publish(request({ revision: 0 }), draftCtx)
  expect(empty.status).toBe(409)
  expect(await empty.json()).toEqual({ error: 'empty_draft' })
  await editDraft(akOne, ['reviewed'])
  const ahead = await publish(request({ revision: 5 }), draftCtx)
  expect(ahead.status).toBe(409)
  expect(await ahead.json()).toMatchObject({
    error: 'superseded_revision',
    confirmation: expect.anything(),
  })
  expect(mocks.start).not.toHaveBeenCalled()
})

test('Publish of a draft too large for one write answers 409 with a clear message and starts nothing', async () => {
  useDraftFixture()
  await editDraft(akOne, ['reviewed'])
  const store = mocks.reviewDeps().store
  const draftId = sharedDraftId(reviewEnv())
  const draft = (await store.getBatch(draftId))!
  // Seeded past the field limits: 40 plates of 256 KiB descriptions is 10 MiB.
  const description = 'x'.repeat(256 * 1024)
  const plates = Array.from({ length: 40 }, (_, i) => ({
    ...akOne,
    id: `AK.big${i}`,
  }))
  expect(
    await store.commit(draftId, draft.revision, {
      batch: {
        ...draft,
        plateIds: [...draft.plateIds, ...plates.map((p) => p.id)],
        revision: draft.revision + 1,
      },
      edits: plates.map((p) => ({
        plateId: p.id,
        fields: { description },
        authorId: 'owner',
        updatedAt: '2026-11-16T12:00:00.000Z',
        baseRevision: plateRevision(p),
        resultRevision: plateRevision({ ...p, description }),
      })),
      history: false,
    })
  ).toBe('ok')
  const refused = await publish(
    request({ revision: draft.revision + 1 }),
    draftCtx
  )
  expect(refused.status).toBe(409)
  expect(await refused.json()).toEqual({
    error: 'draft_too_large',
    message: expect.stringContaining('too large to publish in one write'),
  })
  expect(mocks.start).not.toHaveBeenCalled()
})
