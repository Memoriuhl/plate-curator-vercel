import { createElement, type ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ApiError } from '../../lib/client/api'
import type { Plate } from '../../lib/catalog/types'
import type { PlateCardData } from '../../lib/catalog/dashboard-types'
import type { ReviewBatch } from '../../lib/review/types'
import {
  useMe,
  useBatchRun,
  useReviewActions,
  batchesKey,
  useReorderState,
  useDraftOverlay,
  useEditPlate,
  useBatches,
  useBatch,
  usePlateDetail,
  usePreloadPlateDetail,
  useEnsureBatch,
  type BatchDetail,
} from '../../lib/client/hooks'
import {
  projectFamilyPlate,
  expandFamilyPlate,
} from '../../components/dashboard/family-data'
import { usePlateDrag } from '../../components/dashboard/use-plate-drag'
import { usePublishBaseline, usePublishControl } from '../../lib/client/hooks'

test('batch cache keys distinguish mine and compose it with states', () => {
  expect(batchesKey()).toBe('/api/batches')
  expect(batchesKey([], { mine: false })).toBe('/api/batches')
  expect(batchesKey(undefined, { mine: true })).toBe('/api/batches?mine=1')
  expect(batchesKey(['open', 'submitted'])).toBe(
    '/api/batches?state=open,submitted'
  )
  expect(batchesKey(['open'], { mine: true })).toBe(
    '/api/batches?state=open&mine=1'
  )
})

const session = vi.hoisted(() => ({
  user: { uid: 'jon' },
  api: { get: vi.fn(), send: vi.fn() },
}))
const navigation = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
  query: '',
}))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(navigation.query),
  useRouter: () => navigation,
}))
vi.mock('../../lib/client/session', () => ({ useSession: () => session }))

const ownKey = batchesKey(['open'], { mine: true })
const batch: ReviewBatch = {
  stateOrders: {},
  id: 'draft',
  name: 'AK edits',
  createdBy: 'jon',
  createdByName: null,
  createdAt: '2026-11-16',
  state: 'open',
  revision: 1,
  baselineVersion: 1,
  plateIds: ['AK.one'],
  approval: null,
}
const baseline: Plate = {
  id: 'AK.one',
  state: 'AK',
  slug: 'one',
  displayName: 'Original',
  image: 'one.webp',
  tags: [],
  sourceUrl: 'https://example.com',
}
const proposed: Plate = {
  ...baseline,
  displayName: 'Do not overlay',
  tags: ['one', 'two', 'three'],
  templateFamily: 'family',
  templateRole: 'variant',
  variantOfPlateId: 'AK.parent',
  isStandard: true,
  description: 'A sufficiently detailed description of this plate.',
}
const card: PlateCardData = {
  id: 'AK.one',
  state: 'AK',
  slug: 'one',
  displayName: 'Original',
  imageUrl: '/one.webp',
  imageSize: { width: 320, height: 160 },
  tags: [],
  templateFamily: null,
  templateRole: null,
  variantOfPlateId: null,
  isStandard: false,
  sortOrder: 3,
  revision: 'card-revision',
  complete: false,
  checks: {
    description: { status: 'missing', value: null },
    funFacts: { status: 'missing', value: null },
    link: { status: 'missing', value: null },
    tags: { status: 'missing', value: null },
    family: { status: 'missing', value: null },
    image: { status: 'missing', value: null },
    rarity: { status: 'missing', value: null },
  },
}
/** Build batch detail around the current proposed plate edit and fixture revision. */
function detail(
  edit: BatchDetail['plates'][number]['edit'] = null
): BatchDetail {
  return {
    batch,
    plates: [{ baseline, proposed, edit, revision: 'draft-revision' }],
  }
}
/** Create a private SWR cache and wrapper so hook tests can inspect isolated updates. */
function harness(fallback: Record<string, unknown> = {}) {
  const cache = new Map()
  return {
    cache,
    /** Mount the hook under the harness cache with automatic error retries disabled. */
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(
        SWRConfig,
        {
          value: {
            provider: () => cache,
            fallback,
            dedupingInterval: 0,
            shouldRetryOnError: false,
          },
        },
        children
      ),
  }
}
beforeEach(() => {
  navigation.query = ''
  navigation.refresh.mockClear()
  navigation.replace.mockClear()
  session.api.get
    .mockReset()
    .mockImplementation(async (key: string) =>
      key === ownKey ? [batch] : detail()
    )
  session.api.send.mockReset()
})
afterEach(cleanup)

test('Publish baseline does not poll and the control waits thirty seconds, with mutation refreshing baseline', async () => {
  vi.useFakeTimers()
  try {
    const context = harness()
    session.api.get.mockResolvedValue({
      control: null,
      error: null,
      reviewedVersion: 1,
      liveVersion: 1,
    })
    session.api.send.mockResolvedValue({ control: null })
    const view = renderHook(
      () => ({
        baseline: usePublishBaseline('draft'),
        control: usePublishControl(),
        actions: useReviewActions(),
      }),
      context
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    session.api.get.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29998)
    })
    expect(session.api.get).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2)
    })
    expect(session.api.get.mock.calls.map(([path]) => path)).toEqual([
      '/api/publish/control',
    ])
    session.api.get.mockClear()
    await act(async () => {
      await view.result.current.control.change(false)
    })
    expect(session.api.get).toHaveBeenCalledWith('/api/batches/draft/publish')
    session.api.get.mockClear()
    session.api.send.mockRejectedValueOnce(new ApiError(409, 'paused', {}))
    await act(async () => {
      await view.result.current.actions.publish('draft', 2)
    })
    expect(session.api.get).toHaveBeenCalledWith('/api/batches/draft/publish')
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

test('state hooks fetch on first mount, reuse cached data on revisit, and explicitly refresh after writes', async () => {
  const context = harness()
  /**
   * Read the member, batch list and current detail together to observe their shared
   * cache behavior.
   */
  const useStateHooks = () => ({
    me: useMe(),
    batches: useBatches(['open'], { mine: true }),
    batch: useBatch(batch.id, { reuse: true }),
  })
  const first = renderHook(useStateHooks, context)
  await waitFor(() => expect(first.result.current.batch.data).toBeDefined())
  await waitFor(() => expect(first.result.current.me.data).toBeDefined())
  await waitFor(() => expect(first.result.current.batches.data).toBeDefined())
  first.unmount()
  session.api.get.mockClear()
  const revisit = renderHook(useStateHooks, context)
  expect(revisit.result.current.batch.data).toBeDefined()
  expect(revisit.result.current.batches.data).toBeDefined()
  expect(revisit.result.current.me.data).toBeDefined()
  expect(revisit.result.current.batch.isValidating).toBe(false)
  expect(revisit.result.current.batches.isValidating).toBe(false)
  expect(revisit.result.current.me.isValidating).toBe(false)
  expect(session.api.get).not.toHaveBeenCalled()
  await act(async () => {
    await Promise.all([
      revisit.result.current.batch.mutate(),
      revisit.result.current.batches.mutate(),
      revisit.result.current.me.mutate(),
    ])
  })
  expect(session.api.get.mock.calls.map(([key]) => key).sort()).toEqual(
    ['/api/batches/draft', ownKey, '/api/me'].sort()
  )
})

test('Review and Publish default batch-detail reads revalidate cached state-page data on mount', async () => {
  const context = harness()
  context.cache.set('/api/batches/draft', { data: detail() })
  const statePage = renderHook(
    () => useBatch(batch.id, { reuse: true }),
    context
  )
  expect(statePage.result.current.data?.batch.revision).toBe(1)
  expect(session.api.get).not.toHaveBeenCalled()
  statePage.unmount()
  const updated = { ...detail(), batch: { ...batch, revision: 2 } }
  session.api.get.mockResolvedValue(updated)
  const reviewOrPublish = renderHook(() => useBatch(batch.id), context)
  await waitFor(() =>
    expect(reviewOrPublish.result.current.data?.batch.revision).toBe(2)
  )
  expect(session.api.get).toHaveBeenCalledExactlyOnceWith('/api/batches/draft')
})

test('revisiting cached server cards retains a saved draft family order', async () => {
  const context = harness()
  let order: string[] | undefined
  session.api.get.mockImplementation(async (key: string) =>
    key === ownKey
      ? [batch]
      : {
          ...detail(),
          batch: { ...batch, stateOrders: order ? { AK: order } : {} },
        }
  )
  session.api.send.mockImplementation(async () => {
    order = ['AK.other', card.id]
    return { ...batch, stateOrders: { AK: order } }
  })
  const plates = [card, { ...card, id: 'AK.other', sortOrder: 4 }]
  const first = renderHook(
    () => ({ ordering: useReorderState(), overlay: useDraftOverlay(plates) }),
    context
  )
  await waitFor(() =>
    expect(first.result.current.overlay[0].revision).toBe('draft-revision')
  )
  await act(async () => {
    expect(
      await first.result.current.ordering.reorder('AK', ['AK.other', card.id])
    ).toMatchObject({ ok: true })
  })
  first.unmount()
  const revisit = renderHook(() => useDraftOverlay(plates), context)
  expect(revisit.result.current[0].sortOrder).toBe(1)
  expect(revisit.result.current[1].sortOrder).toBe(0)
})

test('combined move retains lift revision even after a newer Batch enters the cache', async () => {
  const context = harness()
  const { result } = renderHook(() => useReorderState(), context)
  await waitFor(() =>
    expect(result.current.capture()).toEqual({ batchId: 'draft', revision: 1 })
  )
  const origin = result.current.capture()
  context.cache.set('/api/batches/draft', {
    data: { ...detail(), batch: { ...batch, revision: 2 } },
  })
  session.api.send.mockRejectedValue(
    new ApiError(409, 'superseded_revision', {})
  )
  session.api.get.mockResolvedValue({
    ...detail(),
    batch: { ...batch, revision: 2, stateOrders: { AK: ['remote'] } },
  })
  await act(async () =>
    expect(
      await result.current.move(
        'AK',
        ['AK.one'],
        { plateId: 'AK.one', templateFamily: 'new' },
        origin
      )
    ).toEqual({ ok: false, error: 'superseded_revision' })
  )
  expect(session.api.send).toHaveBeenCalledExactlyOnceWith(
    'PUT',
    '/api/batches/draft/state-order/AK',
    {
      batchRevision: 1,
      order: ['AK.one'],
      promotion: { plateId: 'AK.one', templateFamily: 'new' },
    }
  )
  expect(
    context.cache.get('/api/batches/draft').data.batch.stateOrders
  ).toEqual({ AK: ['remote'] })
})

test.each([true, false])(
  'lost move response reconciles saved Batch before reporting success (landed: %s)',
  async (landed) => {
    const context = harness()
    const { result } = renderHook(() => useReorderState(), context)
    await waitFor(() => expect(result.current.capture().revision).toBe(1))
    const origin = result.current.capture()
    session.api.send.mockRejectedValue(new Error('response lost'))
    const saved = landed
      ? {
          ...detail(),
          batch: { ...batch, revision: 2, stateOrders: { AK: ['AK.one'] } },
          plates: [
            {
              ...detail().plates[0],
              proposed: {
                ...proposed,
                templateRole: 'template',
                variantOfPlateId: null,
                templateFamily: 'new',
              },
            },
          ],
        }
      : detail()
    session.api.get.mockResolvedValue(saved)
    await act(async () => {
      const move = result.current.move(
        'AK',
        ['AK.one'],
        { plateId: 'AK.one', templateFamily: 'new' },
        origin
      )
      if (landed)
        expect(await move).toMatchObject({
          ok: true,
          batchId: 'draft',
          revision: 'draft-revision',
        })
      else await expect(move).rejects.toThrow('response lost')
    })
    expect(context.cache.get('/api/batches/draft').data).toEqual(saved)
    expect(session.api.send).toHaveBeenCalledOnce()
  }
)

test('a template move waits for the committed revision and keeps the promotion in the reloaded overlay', async () => {
  const { result } = renderHook(
    () => ({ ordering: useReorderState(), overlay: useDraftOverlay([card]) }),
    harness()
  )
  expect(result.current.ordering.ready).toBe(false)
  await waitFor(() => expect(result.current.ordering.ready).toBe(true))
  const origin = result.current.ordering.capture()
  const savedBatch = { ...batch, revision: 2, stateOrders: { AK: [card.id] } }
  const saved = {
    batch: savedBatch,
    plates: [
      {
        ...detail().plates[0],
        proposed: {
          ...proposed,
          templateFamily: 'new',
          templateRole: 'template',
          variantOfPlateId: null,
        },
      },
    ],
  }
  session.api.send.mockResolvedValue(savedBatch)
  session.api.get
    .mockImplementationOnce(async () => detail())
    .mockImplementation(async (key) => (key === ownKey ? [savedBatch] : saved))
  await act(async () => {
    expect(
      await result.current.ordering.move(
        'AK',
        [card.id],
        { plateId: card.id, templateFamily: 'new' },
        origin
      )
    ).toMatchObject({ ok: true })
  })
  expect(result.current.overlay[0]).toMatchObject({
    templateFamily: 'new',
    templateRole: 'template',
    variantOfPlateId: null,
    sortOrder: 0,
  })
})

test('a successful HTTP response still requires a saved template and order', async () => {
  const { result } = renderHook(() => useReorderState(), harness())
  await waitFor(() => expect(result.current.ready).toBe(true))
  session.api.send.mockResolvedValue({ ...batch, revision: 2 })
  await act(async () => {
    expect(
      await result.current.move(
        'AK',
        [card.id],
        { plateId: card.id, templateFamily: 'new' },
        result.current.capture()
      )
    ).toMatchObject({ ok: false, error: 'superseded_revision' })
  })
})

test('personal Batch discovered after lift cannot inherit its newer revision', async () => {
  const context = harness()
  const { result } = renderHook(() => useReorderState(), context)
  const origin = result.current.capture()
  expect(origin).toEqual({ batchId: null, revision: null })
  await waitFor(() => expect(result.current.capture().revision).toBe(1))
  session.api.send.mockRejectedValue(
    new ApiError(409, 'superseded_revision', {})
  )
  await act(async () =>
    expect(
      await result.current.move(
        'AK',
        ['AK.one'],
        { plateId: 'AK.one', templateFamily: 'new' },
        origin
      )
    ).toEqual({ ok: false, error: 'superseded_revision' })
  )
  expect(session.api.send.mock.calls[0][2].batchRevision).toBe(0)
})

test.each(['merge', 'promote'] as const)(
  '%s drop outside the batch sends the server revision',
  async (action) => {
    const plate = expandFamilyPlate(
      projectFamilyPlate({
        ...card,
        id: 'AK.outside',
        revision: 'server-revision',
        isStandard: false,
        templateRole: action === 'merge' ? 'template' : 'variant',
      })
    )
    const parent = {
      ...card,
      id: 'AK.parent',
      isStandard: true,
      templateRole: 'template' as const,
    }
    const families =
      action === 'merge'
        ? [
            { template: parent, variants: [] },
            { template: plate, variants: [] },
          ]
        : [{ template: parent, variants: [plate] }]
    session.api.send.mockImplementation(async () => {
      const merged = action === 'merge'
      const savedBatch = {
        ...batch,
        revision: 2,
        stateOrders: merged ? {} : { AK: [parent.id, plate.id] },
      }
      session.api.get.mockImplementation(async (key) =>
        key === ownKey
          ? [savedBatch]
          : {
              batch: savedBatch,
              plates: [
                {
                  ...detail().plates[0],
                  proposed: {
                    ...proposed,
                    id: plate.id,
                    templateFamily: 'ak_outside',
                    templateRole: merged ? 'variant' : 'template',
                    variantOfPlateId: merged ? parent.id : null,
                  },
                },
              ],
            }
      )
      return merged
        ? { moved: [plate.id], alreadyInFamily: 0, standard: 0, deleted: 0 }
        : savedBatch
    })
    const { result } = renderHook(() => {
      const ordering = useReorderState()
      return {
        ...usePlateDrag({
          families,
          canEdit: true,
          show: 'all',
          query: '',
          edits: useEditPlate(),
          ordering,
          closePreview: vi.fn(),
          reload: vi.fn(),
          /** Provide the drop targets used by the drag fixture. */
          targets: () => [
            {
              target:
                action === 'merge'
                  ? { kind: 'merge', familyId: parent.id }
                  : { kind: 'family-slot', index: 1 },
              rect: { left: 0, top: 0, right: 500, bottom: 500 },
            },
          ],
        }),
        origin: ordering.capture(),
      }
    }, harness())
    await waitFor(() =>
      expect(result.current.origin).toEqual({ batchId: 'draft', revision: 1 })
    )
    const handle = document.createElement('button')
    document.body.append(handle)
    try {
      act(() =>
        result.current.onPointerDown(
          { kind: action === 'merge' ? 'family' : 'variant', plate },
          {
            button: 0,
            clientX: 100,
            clientY: 100,
            pointerId: 1,
            pointerType: 'mouse',
            currentTarget: handle,
          } as unknown as import('react').PointerEvent<HTMLElement>
        )
      )
      for (const type of ['pointermove', 'pointerup']) {
        const event = new MouseEvent(type, {
          bubbles: true,
          clientX: 110,
          clientY: 100,
          button: 0,
        })
        Object.defineProperties(event, {
          pointerId: { value: 1 },
          pointerType: { value: 'mouse' },
        })
        if (type === 'pointermove') {
          vi.useFakeTimers()
          try {
            act(() => {
              window.dispatchEvent(event)
              vi.advanceTimersByTime(450)
            })
          } finally {
            vi.useRealTimers()
          }
        } else act(() => window.dispatchEvent(event))
      }
      await waitFor(() =>
        expect(result.current.announcement).toBe(
          action === 'merge' ? '1 plate moved' : 'Dropped'
        )
      )
      if (action === 'merge')
        expect(session.api.send).toHaveBeenCalledExactlyOnceWith(
          'POST',
          '/api/batches/draft/family-merge',
          {
            batchRevision: 1,
            members: [{ id: plate.id, revision: 'server-revision' }],
            destination: { id: parent.id, revision: parent.revision },
          }
        )
      else
        expect(session.api.send).toHaveBeenCalledExactlyOnceWith(
          'PUT',
          '/api/batches/draft/state-order/AK',
          {
            batchRevision: 1,
            order: [parent.id, plate.id],
            promotion: { plateId: plate.id, templateFamily: 'ak_outside' },
          }
        )
    } finally {
      handle.remove()
    }
  }
)

test.each(['card', 'batch'])(
  'empty %s revision rejects without sending a PATCH',
  async (source) => {
    session.api.get.mockImplementation(async (key: string) =>
      key === ownKey
        ? [batch]
        : source === 'batch'
          ? { ...detail(), plates: [{ ...detail().plates[0], revision: '' }] }
          : { batch, plates: [] }
    )
    const { result } = renderHook(() => useEditPlate(), harness())
    await act(async () => {
      await expect(
        result.current.edit(
          { ...card, revision: source === 'card' ? '' : card.revision },
          { tags: [] }
        )
      ).rejects.toThrow('Cannot save a plate without a revision')
    })
    expect(session.api.send).not.toHaveBeenCalled()
    expect(result.current.pending).toBe(false)
  }
)

test('draft overlay merges proposed fields and checks without changing card display data', async () => {
  const edit = {
    plateId: card.id,
    baseRevision: 'base',
    fields: { tags: proposed.tags },
    authorId: 'jon',
    updatedAt: '2026-11-16',
    resultRevision: 'draft-revision',
  }
  session.api.get.mockImplementation(async (key: string) =>
    key === ownKey ? [batch] : detail(edit)
  )
  const untouched = { ...card, id: 'AK.other' }
  const plates = [card, untouched]
  const { result, rerender } = renderHook(
    () => useDraftOverlay(plates),
    harness()
  )
  await waitFor(() => expect(result.current[0].changedInBatch).toBe(true))
  expect(result.current[0]).toMatchObject({
    displayName: 'Original',
    imageUrl: '/one.webp',
    sortOrder: 3,
    tags: ['one', 'two', 'three'],
    templateFamily: 'family',
    templateRole: 'variant',
    variantOfPlateId: 'AK.parent',
    isStandard: true,
    revision: 'draft-revision',
    complete: true,
    checks: {
      description: { status: 'good', value: proposed.description },
      image: { status: 'good', value: '/one.webp' },
    },
  })
  expect(result.current[1]).toEqual({ ...untouched, changedInBatch: false })
  const previous = result.current
  rerender()
  expect(result.current).toBe(previous)
  expect(card.tags).toEqual([])
})

test('editing reuses the most recent batch revision and revalidates details and every batch list', async () => {
  const older = { ...batch, id: 'older', createdAt: '2026-11-15' }
  session.api.get.mockImplementation(async (key: string) => {
    if (key === ownKey) return [older, batch]
    if (key.startsWith('/api/batches?') || key === batchesKey()) return [batch]
    return detail()
  })
  session.api.send.mockResolvedValue({ batch, plate: proposed })
  const { result } = renderHook(
    () => ({
      edit: useEditPlate(),
      all: useBatches(),
      submitted: useBatches(['submitted']),
      detail: useBatch(batch.id),
      other: useBatch('other'),
    }),
    harness()
  )
  await waitFor(() => expect(result.current.detail.data).toBeDefined())
  await waitFor(() => expect(result.current.all.data).toBeDefined())
  await waitFor(() => expect(result.current.submitted.data).toBeDefined())
  await waitFor(() => expect(result.current.other.data).toBeDefined())
  session.api.get.mockClear()
  let response
  await act(async () => {
    response = await result.current.edit.edit(card, { tags: proposed.tags })
  })
  expect(response).toMatchObject({ ok: true, proposed })
  expect(session.api.send).toHaveBeenCalledExactlyOnceWith(
    'PATCH',
    '/api/batches/draft/plates/AK.one',
    { baseRevision: 'draft-revision', fields: { tags: proposed.tags } }
  )
  expect(session.api.get).toHaveBeenCalledWith('/api/batches/draft')
  expect(session.api.get).toHaveBeenCalledWith(ownKey)
  expect(session.api.get).toHaveBeenCalledWith(batchesKey())
  expect(session.api.get).toHaveBeenCalledWith(batchesKey(['submitted']))
  expect(session.api.get).not.toHaveBeenCalledWith('/api/batches/other')
})

test('editing a plate outside the batch uses the card revision and fetches uncached detail', async () => {
  session.api.get.mockImplementation(async (key: string) =>
    key === ownKey ? [batch] : { batch, plates: [] }
  )
  session.api.send.mockResolvedValue({ batch, plate: proposed })
  const { result } = renderHook(() => useEditPlate(), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith(ownKey))
  await act(async () => {
    await result.current.edit(card, { description: 'New description' })
  })
  expect(session.api.get).toHaveBeenCalledWith('/api/batches/draft')
  expect(session.api.send).toHaveBeenCalledWith(
    'PATCH',
    '/api/batches/draft/plates/AK.one',
    {
      baseRevision: 'card-revision',
      fields: { description: 'New description' },
    }
  )
})

test.each([
  [409, 'stale_plate'],
  [409, 'superseded_revision'],
  [403, 'forbidden'],
  [404, 'not_found'],
  [422, 'invalid_state'],
] as const)('editing maps HTTP %s %s to a result', async (status, error) => {
  session.api.send.mockRejectedValue(
    new ApiError(status, error, {
      error,
      current: proposed,
      currentRevision: 'saved',
    })
  )
  const { result } = renderHook(() => useEditPlate(), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith(ownKey))
  const fields = { tags: ['mine'] }
  let response
  await act(async () => {
    response = await result.current.edit(card, fields)
  })
  expect(response).toEqual(
    error === 'stale_plate'
      ? {
          ok: false,
          error,
          current: proposed,
          currentRevision: 'saved',
          batchId: 'draft',
          draft: fields,
        }
      : { ok: false, error }
  )
  expect(result.current.pending).toBe(false)
})

test('network failures throw and clear pending', async () => {
  const failure = new TypeError('Network unavailable')
  session.api.send.mockRejectedValue(failure)
  const { result } = renderHook(() => useEditPlate(), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith(ownKey))
  await act(async () => {
    await expect(result.current.edit(card, { tags: ['mine'] })).rejects.toBe(
      failure
    )
  })
  expect(result.current.pending).toBe(false)
})

test('cached batch details supply the revision without another detail fetch', async () => {
  const { result } = renderHook(
    () => ({ edit: useEditPlate(), detail: useBatch(batch.id) }),
    harness()
  )
  await waitFor(() => expect(result.current.detail.data).toBeDefined())
  session.api.get.mockClear()
  session.api.send.mockImplementation(async () => {
    expect(session.api.get).not.toHaveBeenCalledWith('/api/batches/draft')
    return { batch, plate: proposed }
  })
  await act(async () => {
    await result.current.edit.edit(card, { tags: ['one'] })
  })
  expect(session.api.send).toHaveBeenCalledWith(
    'PATCH',
    '/api/batches/draft/plates/AK.one',
    {
      baseRevision: 'draft-revision',
      fields: { tags: ['one'] },
    }
  )
})

test('overlay uses the most recently updated batch and marks unedited entries unchanged', async () => {
  const updated = {
    ...batch,
    id: 'updated',
    createdAt: '2026-11-01',
    updatedAt: '2026-11-17',
  }
  session.api.get.mockImplementation(async (key: string) => {
    if (key === ownKey) return [batch, updated]
    if (key === '/api/batches/updated') return detail()
    throw new Error(`Unexpected key ${key}`)
  })
  const plates = [card, { ...card, id: 'AK.outside' }]
  const { result } = renderHook(() => useDraftOverlay(plates), harness())
  await waitFor(() => expect(result.current[0].revision).toBe('draft-revision'))
  expect(result.current[0].changedInBatch).toBe(false)
  expect(result.current[1]).toEqual({ ...plates[1], changedInBatch: false })
  expect(session.api.get).not.toHaveBeenCalledWith('/api/batches/draft')
})

test('overlay passes cards through when there are no eligible drafts', async () => {
  session.api.get.mockImplementation(async (key: string) =>
    key === ownKey ? [] : { drafts: [] }
  )
  const { result } = renderHook(() => useDraftOverlay([card]), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith(ownKey))
  expect(result.current).toEqual([{ ...card, changedInBatch: false }])
  expect(session.api.get.mock.calls).toEqual([
    [ownKey],
    ['/api/batches?dashboard=AK'],
  ])
})

test('fast edits are serialized, stay pending and use the revision returned after the first save', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let saved = false
  session.api.get.mockImplementation(async (key: string) =>
    key === ownKey
      ? [batch]
      : {
          ...detail(),
          plates: [
            {
              ...detail().plates[0],
              revision: saved ? 'saved-revision' : 'draft-revision',
            },
          ],
        }
  )
  session.api.send
    .mockImplementationOnce(async () => {
      await gate
      saved = true
      return { batch, plate: proposed }
    })
    .mockResolvedValue({ batch, plate: proposed })
  const { result } = renderHook(() => useEditPlate(), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith(ownKey))
  let first!: ReturnType<typeof result.current.edit>
  let second!: ReturnType<typeof result.current.edit>
  act(() => {
    first = result.current.edit(card, { tags: ['first'] })
    second = result.current.edit(card, { tags: ['second'] })
  })
  await waitFor(() => expect(session.api.send).toHaveBeenCalledTimes(1))
  expect(result.current.pending).toBe(true)
  await act(async () => {
    release()
    await Promise.all([first, second])
  })
  expect(session.api.send).toHaveBeenNthCalledWith(
    2,
    'PATCH',
    '/api/batches/draft/plates/AK.one',
    {
      baseRevision: 'saved-revision',
      fields: { tags: ['second'] },
    }
  )
  expect(result.current.pending).toBe(false)
})

test('plate detail fetches the typed plate response and disables fetching for a null id', async () => {
  const response = {
    plate: {
      ...card,
      description: 'Detail',
      category: null,
      sourceUrl: null,
      wikiUrl: null,
    },
    family: [],
    prevId: null,
    nextId: null,
  }
  session.api.get.mockResolvedValue(response)
  const { result, rerender } = renderHook(
    ({ id }: { id: string | null }) => usePlateDetail(id),
    {
      ...harness(),
      initialProps: { id: null as string | null },
    }
  )
  expect(result.current.data).toBeUndefined()
  expect(session.api.get).not.toHaveBeenCalled()
  rerender({ id: card.id })
  await waitFor(() => expect(result.current.data).toEqual(response))
  expect(session.api.get).toHaveBeenCalledExactlyOnceWith('/api/plates/AK.one')
})

test('plate detail preload fetches once with the shared key and the detail hook reuses it', async () => {
  const response = {
    plate: {
      ...card,
      description: 'Detail',
      category: null,
      sourceUrl: null,
      wikiUrl: null,
    },
    family: [],
    prevId: null,
    nextId: null,
  }
  session.api.get.mockResolvedValue(response)
  const preloader = renderHook(() => usePreloadPlateDetail(), harness())
  preloader.result.current('AK.preloaded')
  preloader.result.current('AK.preloaded')
  expect(session.api.get).toHaveBeenCalledExactlyOnceWith(
    '/api/plates/AK.preloaded'
  )
  const { result } = renderHook(() => usePlateDetail('AK.preloaded'), harness())
  await waitFor(() => expect(result.current.data).toEqual(response))
  expect(session.api.get).toHaveBeenCalledOnce()
})

test('plate detail preload does nothing when signed out', () => {
  const user = session.user
  Object.assign(session, { user: null })
  try {
    const { result } = renderHook(() => usePreloadPlateDetail(), harness())
    result.current('AK.signed_out')
    expect(session.api.get).not.toHaveBeenCalled()
  } finally {
    Object.assign(session, { user })
  }
})

test('ensure batch returns the most recently updated own open batch without creating another', async () => {
  const latest = {
    ...batch,
    id: 'latest',
    createdAt: '2026-11-01',
    updatedAt: '2026-11-18',
  }
  session.api.get.mockResolvedValue([batch, latest])
  const { result } = renderHook(() => useEnsureBatch(), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith(ownKey))
  let id
  await act(async () => {
    id = await result.current(card)
  })
  expect(id).toBe('latest')
  expect(session.api.send).not.toHaveBeenCalled()
})

test('ensure batch creates a named batch for the plate and reuses it on the next call', async () => {
  let created = false
  session.api.get.mockImplementation(async () => (created ? [batch] : []))
  session.api.send.mockImplementation(async () => {
    created = true
    return batch
  })
  const { result } = renderHook(() => useEnsureBatch(), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith(ownKey))
  let id
  await act(async () => {
    id = await result.current(card)
  })
  expect(id).toBe(batch.id)
  await act(async () => {
    expect(await result.current({ id: 'AZ.two', state: 'AZ' })).toBe(batch.id)
  })
  expect(session.api.send).toHaveBeenCalledExactlyOnceWith(
    'POST',
    '/api/batches',
    { name: 'AK edits', plateIds: [card.id] }
  )
})

test('ensure batch shares one creation across concurrent callers and hook instances', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  session.api.get.mockResolvedValue([])
  session.api.send.mockImplementation(async () => {
    await gate
    return batch
  })
  const { result } = renderHook(
    () => ({ first: useEnsureBatch(), second: useEnsureBatch() }),
    harness()
  )
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith(ownKey))
  let first!: Promise<string>
  let second!: Promise<string>
  act(() => {
    first = result.current.first(card)
    second = result.current.second({ id: 'AZ.two', state: 'AZ' })
  })
  await waitFor(() => expect(session.api.send).toHaveBeenCalledTimes(1))
  await act(async () => {
    release()
    expect(await Promise.all([first, second])).toEqual([batch.id, batch.id])
  })
  expect(session.api.send).toHaveBeenCalledExactlyOnceWith(
    'POST',
    '/api/batches',
    { name: 'AK edits', plateIds: [card.id] }
  )
})

test('two fast edits create one named batch and save both changes in order', async () => {
  let created = false
  let saves = 0
  session.api.get.mockImplementation(async (key: string) => {
    if (key === ownKey) return created ? [batch] : []
    return {
      batch,
      plates: [
        {
          baseline,
          proposed,
          edit: null,
          revision: saves ? 'saved-revision' : 'batch-baseline',
        },
      ],
    }
  })
  session.api.send.mockImplementation(async (method: string) => {
    if (method === 'POST') {
      created = true
      return batch
    }
    saves += 1
    return { batch, plate: proposed }
  })
  const { result } = renderHook(() => useEditPlate(), harness())
  let responses
  await act(async () => {
    responses = await Promise.all([
      result.current.edit(card, { tags: ['first'] }),
      result.current.edit(card, { description: 'Second change' }),
    ])
  })
  expect(responses).toMatchObject([
    { ok: true, proposed },
    { ok: true, proposed },
  ])
  expect(session.api.send.mock.calls).toEqual([
    ['POST', '/api/batches', { name: 'AK edits', plateIds: [card.id] }],
    [
      'PATCH',
      '/api/batches/draft/plates/AK.one',
      { baseRevision: 'batch-baseline', fields: { tags: ['first'] } },
    ],
    [
      'PATCH',
      '/api/batches/draft/plates/AK.one',
      {
        baseRevision: 'saved-revision',
        fields: { description: 'Second change' },
      },
    ],
  ])
  expect(result.current.pending).toBe(false)
})

test('failed batch creation releases serialization so a later edit can retry', async () => {
  let created = false
  session.api.get.mockImplementation(async (key: string) =>
    key === ownKey ? (created ? [batch] : []) : detail()
  )
  const failure = new TypeError('Network unavailable')
  session.api.send
    .mockRejectedValueOnce(failure)
    .mockImplementation(async (method: string) => {
      if (method === 'POST') {
        created = true
        return batch
      }
      return { batch, plate: proposed }
    })
  const { result } = renderHook(() => useEditPlate(), harness())
  await act(async () => {
    await expect(result.current.edit(card, { tags: ['first'] })).rejects.toBe(
      failure
    )
  })
  expect(result.current.pending).toBe(false)
  await act(async () => {
    expect(await result.current.edit(card, { tags: ['retry'] })).toMatchObject({
      ok: true,
      proposed,
    })
  })
  expect(session.api.send).toHaveBeenCalledTimes(3)
  expect(result.current.pending).toBe(false)
})

test('reorder creates a batch on the first change and serializes using the saved batch revision', async () => {
  let created = false
  let revision = 1
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  session.api.get.mockImplementation(async (key: string) =>
    key === ownKey
      ? created
        ? [batch]
        : []
      : { ...detail(), batch: { ...batch, revision } }
  )
  session.api.send.mockImplementation(async (method: string) => {
    if (method === 'POST') {
      created = true
      return batch
    }
    if (revision === 1) await gate
    revision += 1
    return { ...batch, revision, stateOrders: { AK: ['AK.other', card.id] } }
  })
  const { result } = renderHook(() => useReorderState(), harness())
  let first!: Promise<unknown>
  let second!: Promise<unknown>
  act(() => {
    first = result.current.reorder('AK', ['AK.other', card.id])
    second = result.current.reorder('AK', [card.id, 'AK.other'])
  })
  await waitFor(() => expect(session.api.send).toHaveBeenCalledTimes(2))
  expect(result.current.pending).toBe(true)
  await act(async () => {
    release()
    expect(await Promise.all([first, second])).toMatchObject([
      { ok: true },
      { ok: true },
    ])
  })
  expect(session.api.send.mock.calls).toEqual([
    ['POST', '/api/batches', { name: 'AK edits', plateIds: ['AK.other'] }],
    [
      'PUT',
      '/api/batches/draft/state-order/AK',
      { batchRevision: 1, order: ['AK.other', card.id] },
    ],
    [
      'PUT',
      '/api/batches/draft/state-order/AK',
      { batchRevision: 2, order: [card.id, 'AK.other'] },
    ],
  ])
  expect(result.current.pending).toBe(false)
})

test('overlay applies proposed state order to all cards including plates outside field-edit membership', async () => {
  session.api.get.mockImplementation(async (key: string) =>
    key === ownKey
      ? [batch]
      : {
          ...detail(),
          batch: { ...batch, stateOrders: { AK: ['AK.other', card.id] } },
        }
  )
  const plates = [
    card,
    { ...card, id: 'AK.other', sortOrder: 4 },
    { ...card, id: 'CA.one', state: 'CA' },
  ]
  const { result } = renderHook(() => useDraftOverlay(plates), harness())
  await waitFor(() => expect(result.current[0].sortOrder).toBe(1))
  expect(result.current[1]).toMatchObject({
    id: 'AK.other',
    sortOrder: 0,
    changedInBatch: true,
  })
  expect(result.current[0].changedInBatch).toBe(true)
  expect(result.current[2]).toEqual({ ...plates[2], changedInBatch: false })
})

test('opening a fresh Batch keeps saved plate positions and fields, and new edits win by field', async () => {
  const earlier = { ...batch, stateOrders: { AK: ['AK.other', card.id] } }
  const fresh = { ...batch, id: 'fresh', revision: 0, createdAt: '2026-11-17' }
  const tags = ['saved', 'earlier', 'tags']
  const savedEdit = {
    plateId: card.id,
    baseRevision: card.revision,
    fields: { tags },
    authorId: 'jon',
    updatedAt: '2026-11-16',
    resultRevision: 'earlier-revision',
  }
  const prior = {
    ...detail(savedEdit),
    batch: earlier,
    plates: [
      {
        baseline,
        proposed: { ...baseline, tags },
        edit: savedEdit,
        revision: 'earlier-revision',
      },
    ],
  }
  let active = {
    batch: fresh,
    plates: [
      { baseline, proposed: baseline, edit: null, revision: card.revision },
    ],
  } as BatchDetail
  session.api.get.mockImplementation(async (key: string) => {
    if (key === ownKey) return [earlier]
    if (key === '/api/batches?dashboard=AK') return { drafts: [prior] }
    if (key === '/api/batches/fresh') return active
    if (key === '/api/me') return { uid: 'jon', role: 'owner' }
    return prior
  })
  const plates = [card, { ...card, id: 'AK.other', sortOrder: 4 }]
  const { result, rerender } = renderHook(
    () => ({ cards: useDraftOverlay(plates), selected: useBatch('fresh') }),
    harness()
  )
  await waitFor(() =>
    expect(result.current.cards[0]).toMatchObject({ tags, sortOrder: 1 })
  )

  navigation.query = 'batch=fresh'
  rerender()
  expect(result.current.cards[0]).toMatchObject({ tags, sortOrder: 1 })
  await waitFor(() =>
    expect(result.current.cards[0]).toMatchObject({
      revision: card.revision,
      tags,
      sortOrder: 1,
    })
  )

  const description = 'A longer description saved in the newer Batch.'
  active = {
    batch: { ...fresh, revision: 1 },
    plates: [
      {
        baseline,
        proposed: { ...baseline, description },
        revision: 'fresh-revision',
        edit: {
          ...savedEdit,
          fields: { description },
          updatedAt: '2026-11-17',
          resultRevision: 'fresh-revision',
        },
      },
    ],
  }
  await act(async () => {
    await result.current.selected.mutate()
  })
  expect(result.current.cards[0]).toMatchObject({
    tags,
    sortOrder: 1,
    revision: 'fresh-revision',
    changedInBatch: true,
    checks: { description: { status: 'good', value: description } },
  })
})

test.each([undefined, { AK: '2026-11-16' }])(
  'the most recent state order wins despite a later edit to an older Batch (%j)',
  async (stateOrderChangedAt) => {
    const previousOrder = {
      ...batch,
      id: 'previous',
      lastChangedAt: '2026-11-18',
      stateOrders: { AK: [card.id, 'AK.other'] },
      stateOrderChangedAt,
    }
    const latestOrder = {
      ...batch,
      id: 'latest',
      lastChangedAt: '2026-11-17',
      stateOrders: { AK: ['AK.other', card.id] },
      stateOrderChangedAt: { AK: '2026-11-17' },
    }
    session.api.get.mockImplementation(async (key: string) =>
      key === ownKey
        ? [previousOrder]
        : key === '/api/batches?dashboard=AK'
          ? {
              drafts: [
                { batch: latestOrder, plates: [] },
                { batch: previousOrder, plates: [] },
              ],
            }
          : { batch: previousOrder, plates: [] }
    )
    const plates = [card, { ...card, id: 'AK.other', sortOrder: 4 }]
    const { result } = renderHook(() => useDraftOverlay(plates), harness())
    await waitFor(() =>
      expect(result.current.map((plate) => plate.sortOrder)).toEqual([1, 0])
    )
  }
)

test('a lagging Batch read cannot undo a confirmed reorder', async () => {
  const order = ['AK.other', card.id]
  session.api.send.mockResolvedValue({
    ...batch,
    revision: 2,
    stateOrders: { AK: order },
  })
  const plates = [card, { ...card, id: 'AK.other', sortOrder: 4 }]
  const { result } = renderHook(
    () => ({ ordering: useReorderState(), overlay: useDraftOverlay(plates) }),
    harness()
  )
  await waitFor(() => expect(result.current.ordering.ready).toBe(true))

  await act(async () => {
    expect(await result.current.ordering.reorder('AK', order)).toMatchObject({
      ok: true,
    })
  })

  expect(result.current.ordering.batch?.revision).toBe(2)
  expect(result.current.overlay.map((plate) => plate.sortOrder)).toEqual([1, 0])
})

test('Batch revalidation accepts newer revisions and retains the current order on older reads', async () => {
  const saved = {
    ...batch,
    revision: 2,
    stateOrders: { AK: ['AK.other', card.id] },
  }
  session.api.get.mockResolvedValue({ ...detail(), batch: saved })
  const { result } = renderHook(() => useBatch(batch.id), harness())
  await waitFor(() => expect(result.current.data?.batch).toEqual(saved))

  session.api.get.mockResolvedValueOnce(detail())
  await act(async () => {
    await result.current.mutate()
  })
  expect(result.current.data?.batch).toEqual(saved)

  const newer = {
    ...batch,
    revision: 3,
    stateOrders: { AK: [card.id, 'AK.other'] },
  }
  session.api.get.mockResolvedValueOnce({ ...detail(), batch: newer })
  await act(async () => {
    await result.current.mutate()
  })
  expect(result.current.data?.batch).toEqual(newer)
})

test.each([
  [409, 'superseded_revision'],
  [403, 'forbidden'],
  [404, 'not_found'],
  [422, 'invalid_state'],
] as const)(
  'reorder maps HTTP %s %s and clears pending',
  async (status, error) => {
    session.api.send.mockRejectedValue(new ApiError(status, error, { error }))
    const { result } = renderHook(() => useReorderState(), harness())
    let response
    await act(async () => {
      response = await result.current.reorder('AK', [card.id])
    })
    expect(response).toEqual({ ok: false, error })
    expect(result.current.pending).toBe(false)
  }
)

test('reorder overlays immediately while saving and rolls back on failure so another reorder can retry', async () => {
  let reject!: (error: Error) => void
  const gate = new Promise<never>((_resolve, fail) => {
    reject = fail
  })
  const failure = new TypeError('Network unavailable')
  session.api.send
    .mockReturnValueOnce(gate)
    .mockResolvedValueOnce({ ...batch, revision: 2 })
  const plates = [card, { ...card, id: 'AK.other', sortOrder: 4 }]
  const { result } = renderHook(
    () => ({ reorder: useReorderState(), overlay: useDraftOverlay(plates) }),
    harness()
  )
  await waitFor(() =>
    expect(result.current.overlay[0].revision).toBe('draft-revision')
  )
  let saved!: Promise<unknown>
  act(() => {
    saved = result.current.reorder.reorder('AK', ['AK.other', card.id])
  })
  await waitFor(() => expect(result.current.overlay[0].sortOrder).toBe(1))
  expect(result.current.reorder.pending).toBe(true)
  await act(async () => {
    reject(failure)
    await expect(saved).rejects.toBe(failure)
  })
  expect(result.current.overlay[0].sortOrder).toBe(3)
  expect(result.current.reorder.pending).toBe(false)
  await act(async () => {
    expect(
      await result.current.reorder.reorder('AK', ['AK.other', card.id])
    ).toMatchObject({ ok: true })
  })
})

test('detaching a variant sends null and overlays its own template without the old parent link', async () => {
  const fields = {
    templateRole: 'template' as const,
    variantOfPlateId: null,
    templateFamily: card.id,
  }
  const detached = { ...proposed, ...fields }
  let saved = false
  session.api.get.mockImplementation(async (key: string) =>
    key === ownKey
      ? [batch]
      : {
          batch,
          plates: [
            {
              baseline: proposed,
              proposed: saved ? detached : proposed,
              edit: null,
              revision: saved ? 'detached-revision' : 'variant-revision',
            },
          ],
        }
  )
  session.api.send.mockImplementation(async () => {
    saved = true
    return { batch, plate: detached }
  })
  const plates = [
    {
      ...card,
      templateRole: 'variant' as const,
      variantOfPlateId: 'AK.parent',
      templateFamily: 'family',
    },
  ]
  const { result } = renderHook(
    () => ({ edit: useEditPlate(), overlay: useDraftOverlay(plates) }),
    harness()
  )
  await waitFor(() =>
    expect(result.current.overlay[0].revision).toBe('variant-revision')
  )
  await act(async () => {
    expect(await result.current.edit.edit(plates[0], fields)).toMatchObject({
      ok: true,
      proposed: detached,
    })
  })
  expect(session.api.send).toHaveBeenCalledWith(
    'PATCH',
    '/api/batches/draft/plates/AK.one',
    { baseRevision: 'variant-revision', fields }
  )
  expect(result.current.overlay[0]).toMatchObject({
    templateRole: 'template',
    templateFamily: card.id,
    variantOfPlateId: null,
  })
})

import { fireEvent, render, screen, within } from '@testing-library/react'
import { PublishWorkspace } from '../../components/publish/workspace'
import { ReadyPlatePreview } from '../../components/plate/ready-plate-preview'

test('shared preview consumes the preloaded session API response and draft overlay', async () => {
  let resolveDetail!: (value: unknown) => void
  const response = new Promise((resolve) => {
    resolveDetail = resolve
  })
  const id = 'AK.preview-ready'
  const previewCard = { ...card, id }
  const previewProposed = { ...proposed, id }
  const previewBatch = {
    ...detail(),
    plates: [{ ...detail().plates[0], proposed: previewProposed }],
  }
  session.api.get.mockImplementation((key: string) =>
    key === '/api/plates/' + id
      ? response
      : Promise.resolve(key === ownKey ? [batch] : previewBatch)
  )
  const scope = harness()
  const preload = renderHook(() => usePreloadPlateDetail(), scope)
  act(() => preload.result.current(id))
  const anchor = document.createElement('span')
  document.body.append(anchor)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  const view = render(
    createElement(ReadyPlatePreview, {
      plate: previewCard,
      anchor,
      immediate: false,
      checkKey: 'description',
    }),
    scope
  )
  expect(document.querySelector('[data-check-tooltip]')).toBeNull()
  await act(async () => {
    resolveDetail({
      plate: previewCard,
      family: [],
      prevId: null,
      nextId: null,
    })
    await response
  })
  await waitFor(() =>
    expect(
      document.querySelector('[data-check-tooltip]')?.textContent
    ).toContain(proposed.description)
  )
  expect(
    session.api.get.mock.calls.filter(([key]) => key === '/api/plates/' + id)
  ).toHaveLength(1)
  view.unmount()
  anchor.remove()
  vi.unstubAllGlobals()
})

test.each([
  ['publish_disabled_here', 'Publishing is disabled in this environment.'],
  ['superseded_revision', 'This Batch changed. Confirm the current revision.'],
  [
    'not_waiting',
    'This run is no longer waiting for Publish. Refresh to see its status.',
  ],
  ['forbidden', 'Only the Owner can Publish.'],
  ['not_found', 'This Batch could not be found.'],
])('Publish maps %s and posts the approved revision', async (code, message) => {
  session.api.send.mockRejectedValue(new ApiError(409, code, {}))
  const { result } = renderHook(() => useReviewActions(), harness())
  await act(async () =>
    expect(await result.current.publish('approved', 7)).toEqual({
      ok: false,
      message,
      ...(code === 'superseded_revision' ? { code } : {}),
    })
  )
  expect(session.api.send).toHaveBeenCalledWith(
    'POST',
    '/api/batches/approved/publish',
    { revision: 7, commandId: expect.any(String) }
  )
})

test('Editor never requests run status', async () => {
  session.api.get.mockResolvedValue({ role: 'editor' })
  const { result } = renderHook(() => useBatchRun('restricted'), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith('/api/me'))
  expect(result.current.data).toBeUndefined()
  expect(session.api.get).not.toHaveBeenCalledWith(
    '/api/batches/restricted/run'
  )
})

test.each(['published', 'failed', 'superseded'])(
  'Publish polls through delayed start and stops at %s',
  async (terminal) => {
    let phase = 'waiting-for-publish'
    const id = `poll-${terminal}`
    const key = `/api/batches/${id}/run`
    session.api.get.mockImplementation(async (key: string) =>
      key === '/api/me'
        ? { role: 'owner' }
        : { phase, runId: id, outcome: null, updatedAt: null }
    )
    session.api.send.mockResolvedValue({ status: 'publishing' })
    const { result } = renderHook(
      () => ({ run: useBatchRun(id), actions: useReviewActions() }),
      harness()
    )
    await waitFor(() =>
      expect(result.current.run.data?.phase).toBe('waiting-for-publish')
    )
    vi.useFakeTimers()
    try {
      await act(async () =>
        expect(await result.current.actions.publish(id, 7)).toEqual({
          ok: true,
        })
      )
      phase = 'publishing'
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100)
      })
      expect(result.current.run.data?.phase).toBe('publishing')
      phase = terminal
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100)
      })
      expect(result.current.run.data?.phase).toBe(terminal)
      expect(navigation.refresh).toHaveBeenCalledTimes(
        terminal === 'published' ? 1 : 0
      )
      await act(async () => {
        await result.current.run.mutate()
      })
      expect(navigation.refresh).toHaveBeenCalledTimes(
        terminal === 'published' ? 1 : 0
      )
      const count = session.api.get.mock.calls.filter(
        ([path]) => path === key
      ).length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000)
      })
      expect(
        session.api.get.mock.calls.filter(([path]) => path === key)
      ).toHaveLength(count)
    } finally {
      vi.useRealTimers()
    }
  }
)

test('mounting an already-published batch does not refresh cached pages', async () => {
  session.api.get.mockImplementation(async (key: string) =>
    key === '/api/me'
      ? { role: 'owner' }
      : {
          phase: 'published',
          runId: 'done',
          outcome: { version: 12 },
          updatedAt: null,
        }
  )
  const { result } = renderHook(() => useBatchRun('done'), harness())
  await waitFor(() => expect(result.current.data?.phase).toBe('published'))
  expect(navigation.refresh).not.toHaveBeenCalled()
})

test('switching from an active batch to an already-published batch does not refresh', async () => {
  session.api.get.mockImplementation(async (key: string) =>
    key === '/api/me'
      ? { role: 'owner' }
      : {
          phase: key.includes('/done/') ? 'published' : 'publishing',
          runId: key,
          outcome: null,
          updatedAt: null,
        }
  )
  const { result, rerender } = renderHook(({ id }) => useBatchRun(id), {
    ...harness(),
    initialProps: { id: 'active' },
  })
  await waitFor(() => expect(result.current.data?.phase).toBe('publishing'))
  rerender({ id: 'done' })
  await waitFor(() => expect(result.current.data?.phase).toBe('published'))
  expect(navigation.refresh).not.toHaveBeenCalled()
})

test('Publish keeps the click identity after an ambiguous response and clears it after acceptance', async () => {
  session.api.send
    .mockRejectedValueOnce(new TypeError('lost response'))
    .mockResolvedValue({ status: 'publishing' })
  const { result } = renderHook(() => useReviewActions(), harness())
  await act(async () => {
    await result.current.publish('release', 8)
  })
  const first = session.api.send.mock.calls[0][2]
  await act(async () => {
    await result.current.publish('release', 8)
  })
  expect(session.api.send.mock.calls[1][2]).toEqual(first)
  await act(async () => {
    await result.current.publish('release', 8)
  })
  expect(session.api.send.mock.calls[2][2].commandId).not.toBe(first.commandId)
})

test('Publish confirmation sends the displayed revision and retains its result when lists refresh', async () => {
  let published = false
  const approved = {
    ...batch,
    id: 'release',
    name: 'Veterans release',
    state: 'approved',
    revision: 8,
    approval: { by: 'owner', revision: 7, at: '2026-11-16T12:00:00Z' },
  }
  const other = {
    ...approved,
    id: 'other',
    name: 'Other release',
    approval: { ...approved.approval, at: '2026-11-15T12:00:00Z' },
  }
  session.api.get.mockImplementation(async (key: string) => {
    if (key === '/api/me') return { role: 'owner' }
    if (key.endsWith('/publish'))
      return {
        batchRevision: 8,
        destination: 'license-plate-game-staging',
        enabledHere: true,
        approvalProblems: [],
        error: null,
        retryReason: 'not_waiting',
        confirmation: {
          revision: 8,
          since: null,
          plateCount: 0,
          contributors: [],
        },
      }
    if (key.endsWith('/run'))
      return {
        phase: published ? 'published' : 'waiting-for-publish',
        runId: 'release-run',
        outcome: published ? { version: 12 } : null,
        updatedAt: null,
      }
    if (key.includes('?'))
      return [
        { ...approved, state: published ? 'published' : 'approved' },
        other,
      ]
    return {
      batch: { ...approved, state: published ? 'published' : 'approved' },
      plates: detail({
        plateId: baseline.id,
        fields: { tags: proposed.tags },
        baseRevision: 'old',
        resultRevision: 'new',
        authorId: 'editor',
        updatedAt: approved.approval.at,
      }).plates,
    }
  })
  session.api.send.mockImplementation(async (_method, path) => {
    if (path === '/api/live-access')
      throw new Error('No live subscription in this fixture')
    published = true
    return { status: 'publishing' }
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '')
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open')
    },
  })
  try {
    render(createElement(PublishWorkspace), harness())
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Publish to Game' })
      ).toBeDefined()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Publish to Game' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Publish Veterans release?')
    expect(dialog.textContent).toContain(
      'This creates the next Snapshot for Staging Catalog (license-plate-game-staging).'
    )
    expect(dialog.textContent).toContain('edited')
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Publish revision 8' })
    )
    await waitFor(() =>
      expect(screen.getByText(/Published as Snapshot/)).toBeDefined()
    )
    expect(
      session.api.send.mock.calls.filter(([, path]) =>
        path.endsWith('/publish')
      )
    ).toEqual([
      [
        'POST',
        '/api/batches/release/publish',
        { revision: 8, commandId: expect.any(String) },
      ],
    ])
    expect(navigation.replace).toHaveBeenCalledWith('/publish?batch=release', {
      scroll: false,
    })
    expect(
      within(screen.getByRole('region', { name: 'Approval run' })).getByText(
        'v12'
      )
    ).toBeDefined()
    expect(
      screen.queryByRole('button', { name: 'Publish revision 8' })
    ).toBeNull()
    expect(
      screen.getByRole('heading', { name: 'Veterans release' })
    ).toBeDefined()
  } finally {
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
  }
})

test('move capture reads the saved cache revision before the next promotion', async () => {
  const context = harness()
  const { result } = renderHook(() => useReorderState(), context)
  await waitFor(() => expect(result.current.capture().revision).toBe(1))
  context.cache.set('/api/batches/draft', {
    data: { ...detail(), batch: { ...batch, revision: 8 } },
  })
  expect(result.current.capture()).toEqual({ batchId: 'draft', revision: 8 })
})

test('bulk edit returns the saved revision for compensating edits', async () => {
  session.api.send.mockResolvedValue({ batch, plate: proposed })
  const { result } = renderHook(
    () => useEditPlate({ parallel: true }),
    harness()
  )
  await act(async () => {
    expect(
      await result.current.edit(card, { tags: proposed.tags })
    ).toMatchObject({ ok: true, batchId: 'draft', revision: 'draft-revision' })
  })
})

test('Set as Standard forwards its explicit acknowledgement', async () => {
  session.api.send.mockResolvedValue({ batch, plate: proposed })
  const { result } = renderHook(() => useEditPlate(), harness())
  const standard = { from: 'AK.parent', to: card.id }
  await act(async () => {
    expect(
      (
        await result.current.edit(
          card,
          { isStandard: true },
          undefined,
          standard
        )
      ).ok
    ).toBe(true)
  })
  expect(session.api.send).toHaveBeenCalledWith(
    'PATCH',
    '/api/batches/draft/plates/AK.one',
    { baseRevision: 'draft-revision', fields: { isStandard: true }, standard }
  )
})

test('Batch consumers load bounded pages without mixing two revisions', async () => {
  const key = '/api/batches/draft'
  const first = detail()
  const second = { ...first, batch: { ...batch, revision: 2 } }
  session.api.get
    .mockResolvedValueOnce({ ...first, nextPage: '1.1' })
    .mockRejectedValueOnce(new ApiError(409, 'superseded_revision', {}))
    .mockResolvedValueOnce({ ...second, nextPage: '2.1' })
    .mockResolvedValueOnce({
      ...second,
      plates: [
        {
          ...second.plates[0],
          baseline: { ...baseline, id: 'AK.two' },
          proposed: { ...proposed, id: 'AK.two' },
        },
      ],
    })
  const view = renderHook(() => useBatch('draft'), harness())
  await waitFor(() =>
    expect(
      view.result.current.data?.plates.map((plate) => plate.baseline.id)
    ).toEqual(['AK.one', 'AK.two'])
  )
  expect(view.result.current.data?.batch.revision).toBe(2)
  expect(session.api.get.mock.calls.map(([path]) => path)).toEqual([
    key,
    key + '?page=1.1',
    key,
    key + '?page=2.1',
  ])
})
