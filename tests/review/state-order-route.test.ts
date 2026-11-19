import { beforeEach, expect, test, vi } from 'vitest'
import { PATCH } from '../../app/api/batches/[id]/plates/[plateId]/route'
import { GET } from '../../app/api/batches/[id]/route'
import { plateRevision } from '../../lib/review/revision'
import { PUT } from '../../app/api/batches/[id]/state-order/[state]/route'
import { createMemoryStore } from '../../lib/review/memory-store'
import type { ReviewBatch, ReviewDeps } from '../../lib/review/types'
import type { Plate } from '../../lib/catalog/types'

const context = vi.hoisted(() => ({
  currentActor: vi.fn(),
  reviewDeps: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
  revalidateTag: vi.fn(),
}))
vi.mock('../../lib/server/context', () => context)
const batch = {
  id: 'batch',
  kind: 'shared-draft' as const,
  name: 'Order',
  createdBy: 'editor',
  createdByName: null,
  createdAt: '',
  state: 'open' as const,
  revision: 4,
  baselineVersion: 7,
  plateIds: ['one'],
  stateOrders: {},
  approval: null,
}
beforeEach(() => {
  context.currentActor.mockResolvedValue({
    ok: true,
    actor: { uid: 'editor', name: null, role: 'editor' },
  })
  context.reviewDeps.mockReturnValue({
    store: createMemoryStore([batch]),
    stateBaseline: async () =>
      ['one', 'two'].map((id) => ({
        id,
        state: 'AK',
        slug: id,
        displayName: id,
        image: '',
        tags: [],
        templateRole: 'template' as const,
        isStandard: id === 'one',
      })),
    baselineAtVersion: async () => null,
    baseline: async () => null,
    now: () => '2026-11-17T16:15:00Z',
  } satisfies ReviewDeps)
})
/**
 * Send a state order update through its route using the fixture batch and state
 * parameters.
 */
function put(body: unknown) {
  return PUT(
    new Request('https://example.com/api/batches/batch/state-order/AK', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'batch', state: 'AK' }) }
  )
}
function before(id: string, anchorId: string) {
  return { plateIds: [id], placement: { kind: 'before', anchorId } }
}
function patchPlate(plateId: string, body: unknown) {
  return PATCH(
    new Request(`https://example.com/api/batches/batch/plates/${plateId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'batch', plateId }) }
  )
}

test('discard restores one moved plate and preserves the relative order of the other plates', async () => {
  const deps: ReviewDeps = context.reviewDeps()
  const baseline: Plate[] = ['one', 'two', 'three', 'four', 'five'].map(
    (id) => ({
      id,
      state: 'AK',
      slug: id,
      displayName: id,
      image: '',
      tags: [],
      templateRole: 'template',
      isStandard: id === 'one',
    })
  )
  deps.stateBaseline = async () => baseline
  deps.baselineAtVersion = async (_, id) =>
    baseline.find((plate) => plate.id === id) ?? null
  expect(
    (
      await put({
        moves: [before('three', 'two'), before('five', 'four')],
      })
    ).status
  ).toBe(200)
  expect(
    (await patchPlate('three', { batchRevision: 4, discard: 'order' })).status
  ).toBe(409)
  const response = await patchPlate('three', {
    batchRevision: 5,
    discard: 'order',
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    revision: 6,
    stateOrders: { AK: ['one', 'two', 'three', 'five', 'four'] },
  })
})

test('clearing a replacement Standard restores the linked Standard and its order', async () => {
  const deps: ReviewDeps = context.reviewDeps()
  const baseline = await deps.stateBaseline(7, 'AK')
  deps.baselineAtVersion = async (_, id) =>
    baseline.find((plate) => plate.id === id) ?? null
  expect(
    (
      await put({
        moves: [before('two', 'one')],
        standard: { from: 'one', to: 'two' },
      })
    ).status
  ).toBe(200)
  const response = await patchPlate('two', { batchRevision: 5, discard: 'all' })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    revision: 6,
    plateIds: ['one'],
    stateOrders: {},
  })
  expect(await deps.store.listEdits('batch')).toEqual([])
})
test('signed-in creator receives the updated batch', async () => {
  const response = await put({
    moves: [before('two', 'one')],
    standard: { from: 'one', to: 'two' },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    ...batch,
    lastChangedAt: '2026-11-17T16:15:00Z',
    plateIds: ['one', 'two'],
    revision: 5,
    stateOrders: { AK: ['two', 'one'] },
    stateOrderChangedAt: { AK: '2026-11-17T16:15:00Z' },
    baselineOrders: { AK: ['one', 'two'] },
  })
})

test('combined move promotes the Variant with one revision and skips a repeated placement', async () => {
  const deps = context.reviewDeps()
  const variant = {
    id: 'one',
    state: 'AK',
    slug: 'one',
    displayName: 'One',
    image: '',
    tags: [],
    templateRole: 'variant' as const,
    templateFamily: 'old',
    variantOfPlateId: 'two',
  }
  deps.baselineAtVersion = async () => variant
  deps.stateBaseline = async () => [
    variant,
    {
      ...variant,
      id: 'two',
      templateRole: 'template' as const,
      templateFamily: 'parent',
    },
  ]
  const body = {
    standard: { from: null, to: 'two' },
    moves: [
      {
        plateIds: ['one'],
        placement: { kind: 'after', anchorId: 'two' },
        promote: true,
      },
    ],
  }
  expect((await put(body)).status).toBe(200)
  expect(await deps.store.getBatch('batch')).toMatchObject({
    revision: 5,
    stateOrders: { AK: ['two', 'one'] },
  })
  expect(await deps.store.getEdit('batch', 'one')).toMatchObject({
    fields: {
      templateRole: 'template',
      variantOfPlateId: null,
      templateFamily: 'ak_one',
    },
  })
  expect((await put({ moves: body.moves })).status).toBe(200)
  expect(deps.store.signalRevision('batch')).toBe(5)
})

test.each([
  null,
  {},
  { plateIds: [1], placement: { kind: 'start' } },
  { plateIds: ['one'], placement: { kind: 'after', anchorId: '' } },
])('rejects malformed placement %j', async (move) => {
  expect((await put({ moves: [move] })).status).toBe(400)
})
test('requires sign-in before parsing input', async () => {
  context.currentActor.mockResolvedValue({
    ok: false,
    response: Response.json({ error: 'unauthenticated' }, { status: 401 }),
  })
  expect((await put(null)).status).toBe(401)
})
test.each([
  null,
  {},
  { batchRevision: -1, order: [] },
  { batchRevision: 1.5, order: [] },
  { batchRevision: '4', order: [] },
  { batchRevision: 4, order: [1] },
  { batchRevision: 4, order: 'one' },
])('rejects malformed input %j', async (body) => {
  expect((await put(body)).status).toBe(400)
})
test('rejects unavailable anchors and duplicate moved IDs', async () => {
  const stale = await put({ moves: [before('two', 'missing')] })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({ error: 'superseded_revision' })
  expect(
    (await put({ moves: [before('one', 'two'), before('one', 'two')] })).status
  ).toBe(400)
})
test('an old Batch answers 409 as read-only history and a missing one 404', async () => {
  const legacy: ReviewBatch = { ...batch }
  delete legacy.kind
  context.reviewDeps().store = createMemoryStore([legacy])
  const old = await put({ moves: [before('one', 'two')] })
  expect(old.status).toBe(409)
  expect(await old.json()).toMatchObject({ error: 'history_read_only' })
  context.reviewDeps().store = createMemoryStore([])
  expect((await put({ moves: [before('one', 'two')] })).status).toBe(404)
})

test('a plate PATCH from a tab still on an old Batch answers 409 and saves nothing', async () => {
  const legacy: ReviewBatch = { ...batch }
  delete legacy.kind
  const store = createMemoryStore([legacy])
  context.reviewDeps().store = store
  const plate = {
    id: 'one',
    state: 'AK',
    slug: 'one',
    displayName: 'One',
    image: '',
    tags: [],
  }
  context.reviewDeps().baseline = async () => plate
  context.reviewDeps().baselineAtVersion = async () => plate
  // The creator, with the plate's current revision: only the target is wrong.
  const response = await patchPlate('one', {
    baseRevision: plateRevision(plate),
    fields: { tags: ['late'] },
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: 'history_read_only' })
  expect(await store.listEdits('batch')).toEqual([])
  expect(await store.getBatch('batch')).toMatchObject({ revision: 4 })
})

test('PATCH persists a null variant link and detail exposes the detached template', async () => {
  const baseline = {
    id: 'one',
    state: 'AK',
    slug: 'one',
    displayName: 'One',
    image: '',
    tags: [],
    templateRole: 'variant' as const,
    templateFamily: 'family',
    variantOfPlateId: 'parent',
  }
  context.reviewDeps().baseline = async () => baseline
  context.reviewDeps().baselineAtVersion = async () => baseline
  const fields = {
    templateRole: 'template',
    variantOfPlateId: null,
    templateFamily: 'one',
  }
  const response = await PATCH(
    new Request('https://example.com/api/batches/batch/plates/one', {
      method: 'PATCH',
      body: JSON.stringify({ baseRevision: plateRevision(baseline), fields }),
    }),
    { params: Promise.resolve({ id: 'batch', plateId: 'one' }) }
  )
  expect(response.status).toBe(200)
  const saved = await response.json()
  expect(saved).toMatchObject({ batch: { revision: 5 }, plate: fields })
  const detail = await GET(
    new Request('https://example.com/api/batches/batch'),
    { params: Promise.resolve({ id: 'batch' }) }
  )
  expect(await detail.json()).toMatchObject({
    plates: [
      {
        proposed: fields,
        edit: { fields },
        revision: plateRevision(saved.plate),
      },
    ],
  })
})

test('detail resolves thumbnail URLs without changing reviewed plate fields', async () => {
  vi.stubEnv('PLATE_IMAGE_BASE', 'https://images.example.com')
  try {
    const baseline = {
      id: 'one',
      state: 'AK',
      slug: 'one',
      displayName: 'One',
      image: 'AK/one.webp',
      tags: [],
    }
    context.reviewDeps().baselineAtVersion = async () => baseline
    const response = await GET(
      new Request('https://example.com/api/batches/batch'),
      { params: Promise.resolve({ id: 'batch' }) }
    )
    expect(await response.json()).toMatchObject({
      plates: [
        {
          baseline,
          proposed: baseline,
          beforeImageUrl: 'https://images.example.com/plates/AK/one.webp',
          afterImageUrl: 'https://images.example.com/plates/AK/one.webp',
        },
      ],
    })
  } finally {
    vi.unstubAllEnvs()
  }
})

test('deletion PATCH requires authentication and rejects stale plate revisions', async () => {
  const plate = {
    id: 'one',
    state: 'AK',
    slug: 'one',
    displayName: 'One',
    image: 'one.png',
    tags: [],
  }
  context.reviewDeps().baselineAtVersion = async () => plate
  /** Send the supplied fields through the plate patch route with the fixture revision. */
  const patch = () =>
    PATCH(
      new Request('https://example.com/api/batches/batch/plates/one', {
        method: 'PATCH',
        body: JSON.stringify({
          baseRevision: plateRevision(plate),
          fields: { deleted: true },
        }),
      }),
      { params: Promise.resolve({ id: 'batch', plateId: 'one' }) }
    )
  context.currentActor.mockResolvedValueOnce({
    ok: false,
    response: Response.json({ error: 'unauthenticated' }, { status: 401 }),
  })
  expect((await patch()).status).toBe(401)
  expect((await patch()).status).toBe(200)
  expect((await patch()).status).toBe(409)
  expect(
    await context.reviewDeps().store.getEdit('batch', 'one')
  ).toMatchObject({ fields: { deleted: true } })
})

test('direct PATCH cannot set story fields while local editing is disabled', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  try {
    const response = await PATCH(
      new Request('https://example.com/api/batches/batch/plates/one', {
        method: 'PATCH',
        body: JSON.stringify({
          baseRevision: 'revision',
          fields: {
            funFacts: [
              { text: 'A cited fact', sourceUrl: 'https://example.com/fact' },
            ],
          },
        }),
      }),
      { params: Promise.resolve({ id: 'batch', plateId: 'one' }) }
    )
    expect(response.status).toBe(400)
    expect(await context.reviewDeps().store.listEdits('batch')).toEqual([])
    expect((await context.reviewDeps().store.getBatch('batch'))!.revision).toBe(
      4
    )
  } finally {
    vi.unstubAllEnvs()
  }
})

test('the Batch endpoint pages a large response and binds continuations to one revision', async () => {
  const plateIds = Array.from({ length: 1000 }, (_, index) => 'AK.' + index)
  const draft = { ...batch, plateIds }
  const deps = context.reviewDeps()
  deps.store = createMemoryStore([draft])
  const details = 'source notes '.repeat(1800)
  deps.baselineAtVersion = async (_version: number, id: string) => ({
    id,
    state: 'AK',
    slug: id,
    displayName: id,
    image: '',
    tags: [],
    details,
  })
  /**
   * Request batch detail through the route so pagination behavior uses real request
   * parsing.
   */
  const get = (page?: string) =>
    GET(
      new Request(
        'https://example.com/api/batches/batch' + (page ? '?page=' + page : '')
      ),
      { params: Promise.resolve({ id: 'batch' }) }
    )
  const first = await get()
  const body = await first.text()
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(2_010_000)
  const firstPage = JSON.parse(body)
  expect(firstPage.plates.length).toBeLessThan(100)
  expect(firstPage.plates[0].baseline.id).toBe('AK.0')
  const loaded = firstPage.plates.map(
    (plate: { baseline: { id: string } }) => plate.baseline.id
  )
  let cursor = firstPage.nextPage as string | undefined
  while (cursor) {
    const page = await (await get(cursor)).text()
    expect(Buffer.byteLength(page)).toBeLessThanOrEqual(2_010_000)
    const continuation = JSON.parse(page)
    expect(continuation.batch.revision).toBe(draft.revision)
    loaded.push(
      ...continuation.plates.map(
        (plate: { baseline: { id: string } }) => plate.baseline.id
      )
    )
    cursor = continuation.nextPage
  }
  expect(loaded).toEqual(plateIds)
  expect(
    await deps.store.commit(draft.id, draft.revision, {
      batch: { ...draft, revision: draft.revision + 1 },
    })
  ).toBe('ok')
  expect((await get(firstPage.nextPage)).status).toBe(409)
})

test('applies stale-screen moves to the current state order across a rebase floor', async () => {
  const deps: ReviewDeps = context.reviewDeps()
  deps.stateBaseline = async () =>
    ['one', 'two', 'three', 'four', 'five'].map((id) => ({
      id,
      state: 'AK',
      slug: id,
      displayName: id,
      image: '',
      tags: [],
      templateRole: 'template',
      isStandard: id === 'one',
    }))
  const initial = {
    ...batch,
    revision: 8,
    rebaseFloor: 8,
    stateOrders: { AL: ['AL.two', 'AL.one'] },
  }
  deps.store = createMemoryStore([initial])
  const listChanges = vi.spyOn(deps.store, 'listChanges')
  const move = (id: string, anchorId: string) =>
    put({
      moves: [{ plateIds: [id], placement: { kind: 'before', anchorId } }],
    })
  expect((await move('five', 'three')).status).toBe(200)
  expect((await move('two', 'four')).status).toBe(200)
  const competing = await move('five', 'four')
  expect(competing.status).toBe(200)
  expect(await competing.json()).toMatchObject({
    revision: 11,
    stateOrders: {
      AK: ['one', 'three', 'two', 'five', 'four'],
      AL: initial.stateOrders.AL,
    },
  })
  expect(listChanges).not.toHaveBeenCalled()
})

test('reports the editor who saved the conflicting field even after a different field was edited', async () => {
  const deps: ReviewDeps = context.reviewDeps()
  const [plate, other] = await deps.stateBaseline(7, 'AK')
  deps.baselineAtVersion = async (_, id) =>
    [plate, other].find((member) => member.id === id) ?? null
  const editAs = (uid: string, name: string, at: string) => {
    context.currentActor.mockResolvedValue({
      ok: true,
      actor: { uid, name, role: 'editor' },
    })
    deps.now = () => at
  }
  const at = '2026-11-18T22:10:00Z'
  editAs('first', 'First Curator', at)
  const first = await patchPlate(plate.id, {
    baseRevision: plateRevision(plate),
    fields: { tags: ['saved'] },
  })
  expect(first.status).toBe(200)
  editAs('second', 'Second Curator', '2026-11-18T22:11:00Z')
  expect(
    (
      await patchPlate(plate.id, {
        baseRevision: plateRevision((await first.json()).plate),
        fields: { description: 'different field' },
      })
    ).status
  ).toBe(200)
  expect(
    (
      await patchPlate(other.id, {
        baseRevision: plateRevision(other),
        fields: { tags: ['separate plate'] },
      })
    ).status
  ).toBe(200)
  const stale = await patchPlate(plate.id, {
    baseRevision: plateRevision(plate),
    fields: { tags: ['stale'] },
  })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({
    error: 'stale_plate',
    current: { tags: ['saved'] },
    conflicts: {
      tags: { by: 'first', byName: 'First Curator', at, value: ['saved'] },
    },
  })
})

test('joins the current family as a block and only changes the Standard with confirmation', async () => {
  const deps: ReviewDeps = context.reviewDeps()
  const baseline: Plate[] = [
    {
      id: 'one',
      templateRole: 'template',
      templateFamily: 'first',
      isStandard: true,
    },
    {
      id: 'variant',
      templateRole: 'variant',
      templateFamily: 'first',
      variantOfPlateId: 'one',
    },
    { id: 'two', templateRole: 'template', templateFamily: 'second' },
    { id: 'three', templateRole: 'template', templateFamily: 'third' },
  ].map((plate) => ({
    state: 'AK',
    slug: plate.id,
    displayName: plate.id,
    image: '',
    tags: [],
    ...plate,
  })) as Plate[]
  deps.stateBaseline = async () => baseline
  const moves = [
    { plateIds: ['one'], placement: { kind: 'join', anchorId: 'three' } },
  ]
  expect((await put({ moves })).status).toBe(409)
  expect(await deps.store.listEdits('batch')).toEqual([])
  expect(
    (await put({ moves, standard: { from: 'one', to: 'two' } })).status
  ).toBe(200)
  expect(await deps.store.getBatch('batch')).toMatchObject({
    revision: 5,
    stateOrders: { AK: ['two', 'three', 'one', 'variant'] },
  })
  expect(await deps.store.getEdit('batch', 'two')).toMatchObject({
    fields: { isStandard: true },
  })
  expect(await deps.store.getEdit('batch', 'one')).toMatchObject({
    fields: {
      templateRole: 'variant',
      variantOfPlateId: 'three',
      isStandard: false,
    },
  })
  expect(await deps.store.getEdit('batch', 'variant')).toMatchObject({
    fields: { templateFamily: 'third', variantOfPlateId: 'three' },
  })
  expect(
    (
      await put({
        moves: [
          {
            plateIds: ['AL.outside'],
            placement: { kind: 'join', anchorId: 'three' },
          },
        ],
      })
    ).status
  ).toBe(422)
  expect(
    (
      await put({
        moves: [
          {
            plateIds: ['variant'],
            placement: { kind: 'before-plate', anchorId: 'two' },
          },
        ],
      })
    ).status
  ).toBe(409)
  expect(await deps.store.getBatch('batch')).toMatchObject({ revision: 5 })
})
