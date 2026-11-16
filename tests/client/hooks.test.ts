import { createElement, type ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ApiError } from '../../lib/client/api'
import type { Plate } from '../../lib/catalog/types'
import type { PlateCardData } from '../../lib/catalog/dashboard-types'
import type { ReviewBatch } from '../../lib/review/types'
import { useBatchRun, useReviewActions, batchesKey, useReorderState, useDraftOverlay, useEditPlate, useBatches, useBatch, usePlateDetail, usePreloadPlateDetail, useEnsureBatch, type BatchDetail } from '../../lib/client/hooks'
import { projectFamilyPlate, expandFamilyPlate } from '../../components/dashboard/family-data'
import { usePlateDrag } from '../../components/dashboard/use-plate-drag'

test('batch cache keys distinguish mine and compose it with states', () => {
  expect(batchesKey()).toBe('/api/batches')
  expect(batchesKey([], { mine: false })).toBe('/api/batches')
  expect(batchesKey(undefined, { mine: true })).toBe('/api/batches?mine=1')
  expect(batchesKey(['open', 'submitted'])).toBe('/api/batches?state=open,submitted')
  expect(batchesKey(['open'], { mine: true })).toBe('/api/batches?state=open&mine=1')
})

const session = vi.hoisted(() => ({ user: { uid: 'jon' }, api: { get: vi.fn(), send: vi.fn() } }))
vi.mock('../../lib/client/session', () => ({ useSession: () => session }))

const ownKey = batchesKey(['open'], { mine: true })
const batch: ReviewBatch = {
  stateOrders: {},
  id: 'draft', name: 'AK edits', createdBy: 'jon', createdByName: null, createdAt: '2026-11-16', state: 'open',
  revision: 1, baselineVersion: 1, plateIds: ['AK.one'], approval: null,
}
const baseline: Plate = {
  id: 'AK.one', state: 'AK', slug: 'one', displayName: 'Original', image: 'one.webp', tags: [],
  sourceUrl: 'https://example.com',
}
const proposed: Plate = {
  ...baseline, displayName: 'Do not overlay', tags: ['one', 'two', 'three'],
  templateFamily: 'family', templateRole: 'variant', variantOfPlateId: 'AK.parent', isStandard: true,
  description: 'A sufficiently detailed description of this plate.',
}
const card: PlateCardData = {
  id: 'AK.one', state: 'AK', slug: 'one', displayName: 'Original', imageUrl: '/one.webp',
  imageSize: { width: 320, height: 160 }, tags: [], templateFamily: null, templateRole: null,
  variantOfPlateId: null, isStandard: false, sortOrder: 3, revision: 'card-revision', complete: false,
  checks: {
    description: { status: 'missing', value: null }, funFacts: { status: 'missing', value: null },
    link: { status: 'missing', value: null }, tags: { status: 'missing', value: null },
    family: { status: 'missing', value: null }, image: { status: 'missing', value: null },
    rarity: { status: 'missing', value: null },
  },
}
function detail(edit: BatchDetail['plates'][number]['edit'] = null): BatchDetail {
  return { batch, plates: [{ baseline, proposed, edit, revision: 'draft-revision' }] }
}
function harness(fallback: Record<string, unknown> = {}) {
  const cache = new Map()
  return {
    cache,
    wrapper: ({ children }: { children: ReactNode }) => createElement(SWRConfig, {
      value: { provider: () => cache, fallback, dedupingInterval: 0, shouldRetryOnError: false },
    }, children),
  }
}
beforeEach(() => {
  session.api.get.mockReset().mockImplementation(async (key: string) => key === ownKey ? [batch] : detail())
  session.api.send.mockReset()
})
afterEach(cleanup)

test.each(['merge', 'promote'] as const)('%s drop outside the batch sends the server revision', async action => {
  const plate = expandFamilyPlate(projectFamilyPlate({ ...card, id: 'AK.outside', revision: 'server-revision', templateRole: action === 'merge' ? 'template' : 'variant' }))
  const parent = { ...card, id: 'AK.parent', templateRole: 'template' as const }
  const families = action === 'merge'
    ? [{ template: parent, variants: [] }, { template: plate, variants: [] }]
    : [{ template: parent, variants: [plate] }]
  session.api.send.mockResolvedValue({ batch, plate: proposed })
  const reorder = vi.fn().mockResolvedValue({ ok: true })
  const { result } = renderHook(() => usePlateDrag({
    families, canEdit: true, show: 'all', query: '', edits: useEditPlate(),
    ordering: { reorder, pending: false }, closePreview: vi.fn(), reload: vi.fn(),
    targets: () => [{ target: action === 'merge' ? { kind: 'merge', familyId: parent.id } : { kind: 'family-slot', index: 1 }, rect: { left: 0, top: 0, right: 500, bottom: 500 } }],
  }), harness())
  const handle = document.createElement('button')
  document.body.append(handle)
  try {
    act(() => result.current.onPointerDown({ kind: action === 'merge' ? 'family' : 'variant', plate }, {
      button: 0, clientX: 100, clientY: 100, pointerId: 1, pointerType: 'mouse', currentTarget: handle,
    } as unknown as import('react').PointerEvent<HTMLElement>))
    for (const type of ['pointermove', 'pointerup']) {
      const event = new MouseEvent(type, { bubbles: true, clientX: 110, clientY: 100, button: 0 })
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
      act(() => { window.dispatchEvent(event) })
    }
    await waitFor(() => expect(result.current.announcement).toBe('Dropped'))
    expect(session.api.send).toHaveBeenCalledExactlyOnceWith('PATCH', '/api/batches/draft/plates/AK.outside', {
      baseRevision: 'server-revision',
      fields: action === 'merge'
        ? { templateRole: 'variant', variantOfPlateId: parent.id, templateFamily: parent.id }
        : { templateRole: 'template', variantOfPlateId: null, templateFamily: 'ak_outside' },
    })
  } finally { handle.remove() }
})

test.each(['card', 'batch'])('empty %s revision rejects without sending a PATCH', async source => {
  session.api.get.mockImplementation(async (key: string) => key === ownKey ? [batch] : source === 'batch'
    ? { ...detail(), plates: [{ ...detail().plates[0], revision: '' }] }
    : { batch, plates: [] })
  const { result } = renderHook(() => useEditPlate(), harness())
  await act(async () => {
    await expect(result.current.edit({ ...card, revision: source === 'card' ? '' : card.revision }, { tags: [] })).rejects.toThrow('Cannot save a plate without a revision')
  })
  expect(session.api.send).not.toHaveBeenCalled()
  expect(result.current.pending).toBe(false)
})

test('draft overlay merges proposed fields and checks without changing card display data', async () => {
  const edit = { plateId: card.id, baseRevision: 'base', fields: { tags: proposed.tags }, authorId: 'jon', updatedAt: '2026-11-16', resultRevision: 'draft-revision' }
  session.api.get.mockImplementation(async (key: string) => key === ownKey ? [batch] : detail(edit))
  const untouched = { ...card, id: 'AK.other' }
  const plates = [card, untouched]
  const { result, rerender } = renderHook(() => useDraftOverlay(plates), harness())
  await waitFor(() => expect(result.current[0].changedInBatch).toBe(true))
  expect(result.current[0]).toMatchObject({
    displayName: 'Original', imageUrl: '/one.webp', sortOrder: 3, tags: ['one', 'two', 'three'],
    templateFamily: 'family', templateRole: 'variant', variantOfPlateId: 'AK.parent', isStandard: true,
    revision: 'draft-revision', complete: true,
    checks: { description: { status: 'good', value: proposed.description }, image: { status: 'good', value: '/one.webp' } },
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
  const { result } = renderHook(() => ({
    edit: useEditPlate(), all: useBatches(), submitted: useBatches(['submitted']),
    detail: useBatch(batch.id), other: useBatch('other'),
  }), harness())
  await waitFor(() => expect(result.current.detail.data).toBeDefined())
  await waitFor(() => expect(result.current.all.data).toBeDefined())
  await waitFor(() => expect(result.current.submitted.data).toBeDefined())
  await waitFor(() => expect(result.current.other.data).toBeDefined())
  session.api.get.mockClear()
  let response
  await act(async () => { response = await result.current.edit.edit(card, { tags: proposed.tags }) })
  expect(response).toEqual({ ok: true, proposed })
  expect(session.api.send).toHaveBeenCalledExactlyOnceWith('PATCH', '/api/batches/draft/plates/AK.one', { baseRevision: 'draft-revision', fields: { tags: proposed.tags } })
  expect(session.api.get).toHaveBeenCalledWith('/api/batches/draft')
  expect(session.api.get).toHaveBeenCalledWith(ownKey)
  expect(session.api.get).toHaveBeenCalledWith(batchesKey())
  expect(session.api.get).toHaveBeenCalledWith(batchesKey(['submitted']))
  expect(session.api.get).not.toHaveBeenCalledWith('/api/batches/other')
})

test('editing a plate outside the batch uses the card revision and fetches uncached detail', async () => {
  session.api.get.mockImplementation(async (key: string) => key === ownKey ? [batch] : { batch, plates: [] })
  session.api.send.mockResolvedValue({ batch, plate: proposed })
  const { result } = renderHook(() => useEditPlate(), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith(ownKey))
  await act(async () => { await result.current.edit(card, { description: 'New description' }) })
  expect(session.api.get).toHaveBeenCalledWith('/api/batches/draft')
  expect(session.api.send).toHaveBeenCalledWith('PATCH', '/api/batches/draft/plates/AK.one', {
    baseRevision: 'card-revision', fields: { description: 'New description' },
  })
})

test.each([
  [409, 'stale_plate'], [409, 'superseded_revision'], [403, 'forbidden'], [404, 'not_found'], [422, 'invalid_state'],
] as const)('editing maps HTTP %s %s to a result', async (status, error) => {
  session.api.send.mockRejectedValue(new ApiError(status, error, { error, current: proposed }))
  const { result } = renderHook(() => useEditPlate(), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith(ownKey))
  const fields = { tags: ['mine'] }
  let response
  await act(async () => { response = await result.current.edit(card, fields) })
  expect(response).toEqual(error === 'stale_plate'
    ? { ok: false, error, current: proposed, draft: fields }
    : { ok: false, error })
  expect(result.current.pending).toBe(false)
})

test('network failures throw and clear pending', async () => {
  const failure = new TypeError('Network unavailable')
  session.api.send.mockRejectedValue(failure)
  const { result } = renderHook(() => useEditPlate(), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith(ownKey))
  await act(async () => { await expect(result.current.edit(card, { tags: ['mine'] })).rejects.toBe(failure) })
  expect(result.current.pending).toBe(false)
})

test('cached batch details supply the revision without another detail fetch', async () => {
  const { result } = renderHook(() => ({ edit: useEditPlate(), detail: useBatch(batch.id) }), harness())
  await waitFor(() => expect(result.current.detail.data).toBeDefined())
  session.api.get.mockClear()
  session.api.send.mockImplementation(async () => {
    expect(session.api.get).not.toHaveBeenCalledWith('/api/batches/draft')
    return { batch, plate: proposed }
  })
  await act(async () => { await result.current.edit.edit(card, { tags: ['one'] }) })
  expect(session.api.send).toHaveBeenCalledWith('PATCH', '/api/batches/draft/plates/AK.one', {
    baseRevision: 'draft-revision', fields: { tags: ['one'] },
  })
})

test('overlay uses the most recently updated batch and marks unedited entries unchanged', async () => {
  const updated = { ...batch, id: 'updated', createdAt: '2026-11-01', updatedAt: '2026-11-17' }
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

test('overlay passes cards through when there is no own open batch', async () => {
  session.api.get.mockResolvedValue([])
  const { result } = renderHook(() => useDraftOverlay([card]), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith(ownKey))
  expect(result.current).toEqual([{ ...card, changedInBatch: false }])
  expect(session.api.get).toHaveBeenCalledTimes(1)
})

test('fast edits are serialized, stay pending and use the revision returned after the first save', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let saved = false
  session.api.get.mockImplementation(async (key: string) => key === ownKey ? [batch] : {
    ...detail(), plates: [{ ...detail().plates[0], revision: saved ? 'saved-revision' : 'draft-revision' }],
  })
  session.api.send.mockImplementationOnce(async () => {
    await gate
    saved = true
    return { batch, plate: proposed }
  }).mockResolvedValue({ batch, plate: proposed })
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
  await act(async () => { release(); await Promise.all([first, second]) })
  expect(session.api.send).toHaveBeenNthCalledWith(2, 'PATCH', '/api/batches/draft/plates/AK.one', {
    baseRevision: 'saved-revision', fields: { tags: ['second'] },
  })
  expect(result.current.pending).toBe(false)
})

test('plate detail fetches the typed plate response and disables fetching for a null id', async () => {
  const response = { plate: { ...card, description: 'Detail', category: null, sourceUrl: null, wikiUrl: null }, family: [], prevId: null, nextId: null }
  session.api.get.mockResolvedValue(response)
  const { result, rerender } = renderHook(({ id }: { id: string | null }) => usePlateDetail(id), {
    ...harness(), initialProps: { id: null as string | null },
  })
  expect(result.current.data).toBeUndefined()
  expect(session.api.get).not.toHaveBeenCalled()
  rerender({ id: card.id })
  await waitFor(() => expect(result.current.data).toEqual(response))
  expect(session.api.get).toHaveBeenCalledExactlyOnceWith('/api/plates/AK.one')
})

test('plate detail preload fetches once with the shared key and the detail hook reuses it', async () => {
  const response = { plate: { ...card, description: 'Detail', category: null, sourceUrl: null, wikiUrl: null }, family: [], prevId: null, nextId: null }
  session.api.get.mockResolvedValue(response)
  const preloader = renderHook(() => usePreloadPlateDetail(), harness())
  preloader.result.current('AK.preloaded')
  preloader.result.current('AK.preloaded')
  expect(session.api.get).toHaveBeenCalledExactlyOnceWith('/api/plates/AK.preloaded')
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
  const latest = { ...batch, id: 'latest', createdAt: '2026-11-01', updatedAt: '2026-11-18' }
  session.api.get.mockResolvedValue([batch, latest])
  const { result } = renderHook(() => useEnsureBatch(), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith(ownKey))
  let id
  await act(async () => { id = await result.current(card) })
  expect(id).toBe('latest')
  expect(session.api.send).not.toHaveBeenCalled()
})

test('ensure batch creates a named batch for the plate and reuses it on the next call', async () => {
  let created = false
  session.api.get.mockImplementation(async () => created ? [batch] : [])
  session.api.send.mockImplementation(async () => { created = true; return batch })
  const { result } = renderHook(() => useEnsureBatch(), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith(ownKey))
  let id
  await act(async () => { id = await result.current(card) })
  expect(id).toBe(batch.id)
  await act(async () => { expect(await result.current({ id: 'AZ.two', state: 'AZ' })).toBe(batch.id) })
  expect(session.api.send).toHaveBeenCalledExactlyOnceWith('POST', '/api/batches', { name: 'AK edits', plateIds: [card.id] })
})

test('ensure batch shares one creation across concurrent callers and hook instances', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  session.api.get.mockResolvedValue([])
  session.api.send.mockImplementation(async () => { await gate; return batch })
  const { result } = renderHook(() => ({ first: useEnsureBatch(), second: useEnsureBatch() }), harness())
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
  expect(session.api.send).toHaveBeenCalledExactlyOnceWith('POST', '/api/batches', { name: 'AK edits', plateIds: [card.id] })
})

test('two fast edits create one named batch and save both changes in order', async () => {
  let created = false
  let saves = 0
  session.api.get.mockImplementation(async (key: string) => {
    if (key === ownKey) return created ? [batch] : []
    return { batch, plates: [{ baseline, proposed, edit: null, revision: saves ? 'saved-revision' : 'batch-baseline' }] }
  })
  session.api.send.mockImplementation(async (method: string) => {
    if (method === 'POST') { created = true; return batch }
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
  expect(responses).toEqual([{ ok: true, proposed }, { ok: true, proposed }])
  expect(session.api.send.mock.calls).toEqual([
    ['POST', '/api/batches', { name: 'AK edits', plateIds: [card.id] }],
    ['PATCH', '/api/batches/draft/plates/AK.one', { baseRevision: 'batch-baseline', fields: { tags: ['first'] } }],
    ['PATCH', '/api/batches/draft/plates/AK.one', { baseRevision: 'saved-revision', fields: { description: 'Second change' } }],
  ])
  expect(result.current.pending).toBe(false)
})

test('failed batch creation releases serialization so a later edit can retry', async () => {
  let created = false
  session.api.get.mockImplementation(async (key: string) => key === ownKey ? (created ? [batch] : []) : detail())
  const failure = new TypeError('Network unavailable')
  session.api.send.mockRejectedValueOnce(failure).mockImplementation(async (method: string) => {
    if (method === 'POST') { created = true; return batch }
    return { batch, plate: proposed }
  })
  const { result } = renderHook(() => useEditPlate(), harness())
  await act(async () => { await expect(result.current.edit(card, { tags: ['first'] })).rejects.toBe(failure) })
  expect(result.current.pending).toBe(false)
  await act(async () => { expect(await result.current.edit(card, { tags: ['retry'] })).toEqual({ ok: true, proposed }) })
  expect(session.api.send).toHaveBeenCalledTimes(3)
  expect(result.current.pending).toBe(false)
})

test('reorder creates a batch on the first change and serializes using the saved batch revision', async () => {
  let created = false
  let revision = 1
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  session.api.get.mockImplementation(async (key: string) => key === ownKey ? (created ? [batch] : []) : { ...detail(), batch: { ...batch, revision } })
  session.api.send.mockImplementation(async (method: string) => {
    if (method === 'POST') { created = true; return batch }
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
  await act(async () => { release(); expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]) })
  expect(session.api.send.mock.calls).toEqual([
    ['POST', '/api/batches', { name: 'AK edits', plateIds: ['AK.other'] }],
    ['PUT', '/api/batches/draft/state-order/AK', { batchRevision: 1, order: ['AK.other', card.id] }],
    ['PUT', '/api/batches/draft/state-order/AK', { batchRevision: 2, order: [card.id, 'AK.other'] }],
  ])
  expect(result.current.pending).toBe(false)
})

test('overlay applies proposed state order to all cards including plates outside field-edit membership', async () => {
  session.api.get.mockImplementation(async (key: string) => key === ownKey ? [batch] : {
    ...detail(), batch: { ...batch, stateOrders: { AK: ['AK.other', card.id] } },
  })
  const plates = [card, { ...card, id: 'AK.other', sortOrder: 4 }, { ...card, id: 'CA.one', state: 'CA' }]
  const { result } = renderHook(() => useDraftOverlay(plates), harness())
  await waitFor(() => expect(result.current[0].sortOrder).toBe(1))
  expect(result.current[1]).toMatchObject({ id: 'AK.other', sortOrder: 0, changedInBatch: true })
  expect(result.current[0].changedInBatch).toBe(true)
  expect(result.current[2]).toEqual({ ...plates[2], changedInBatch: false })
})

test.each([[409, 'superseded_revision'], [403, 'forbidden'], [404, 'not_found'], [422, 'invalid_state']] as const)('reorder maps HTTP %s %s and clears pending', async (status, error) => {
  session.api.send.mockRejectedValue(new ApiError(status, error, { error }))
  const { result } = renderHook(() => useReorderState(), harness())
  let response
  await act(async () => { response = await result.current.reorder('AK', [card.id]) })
  expect(response).toEqual({ ok: false, error })
  expect(result.current.pending).toBe(false)
})

test('reorder overlays immediately while saving and rolls back on failure so another reorder can retry', async () => {
  let reject!: (error: Error) => void
  const gate = new Promise<never>((_resolve, fail) => { reject = fail })
  const failure = new TypeError('Network unavailable')
  session.api.send.mockReturnValueOnce(gate).mockResolvedValueOnce({ ...batch, revision: 2 })
  const plates = [card, { ...card, id: 'AK.other', sortOrder: 4 }]
  const { result } = renderHook(() => ({ reorder: useReorderState(), overlay: useDraftOverlay(plates) }), harness())
  await waitFor(() => expect(result.current.overlay[0].revision).toBe('draft-revision'))
  let saved!: Promise<unknown>
  act(() => { saved = result.current.reorder.reorder('AK', ['AK.other', card.id]) })
  await waitFor(() => expect(result.current.overlay[0].sortOrder).toBe(1))
  expect(result.current.reorder.pending).toBe(true)
  await act(async () => { reject(failure); await expect(saved).rejects.toBe(failure) })
  expect(result.current.overlay[0].sortOrder).toBe(3)
  expect(result.current.reorder.pending).toBe(false)
  await act(async () => { expect(await result.current.reorder.reorder('AK', ['AK.other', card.id])).toEqual({ ok: true }) })
})

test('detaching a variant sends null and overlays its own template without the old parent link', async () => {
  const fields = { templateRole: 'template' as const, variantOfPlateId: null, templateFamily: card.id }
  const detached = { ...proposed, ...fields }
  let saved = false
  session.api.get.mockImplementation(async (key: string) => key === ownKey ? [batch] : {
    batch, plates: [{ baseline: proposed, proposed: saved ? detached : proposed, edit: null, revision: saved ? 'detached-revision' : 'variant-revision' }],
  })
  session.api.send.mockImplementation(async () => { saved = true; return { batch, plate: detached } })
  const plates = [{ ...card, templateRole: 'variant' as const, variantOfPlateId: 'AK.parent', templateFamily: 'family' }]
  const { result } = renderHook(() => ({ edit: useEditPlate(), overlay: useDraftOverlay(plates) }), harness())
  await waitFor(() => expect(result.current.overlay[0].revision).toBe('variant-revision'))
  await act(async () => { expect(await result.current.edit.edit(plates[0], fields)).toEqual({ ok: true, proposed: detached }) })
  expect(session.api.send).toHaveBeenCalledWith('PATCH', '/api/batches/draft/plates/AK.one', { baseRevision: 'variant-revision', fields })
  expect(result.current.overlay[0]).toMatchObject({ templateRole: 'template', templateFamily: card.id, variantOfPlateId: null })
})

import { fireEvent, render, screen, within } from '@testing-library/react'
import { PublishWorkspace } from '../../components/publish/workspace'
import { ReadyPlatePreview } from '../../components/plate/ready-plate-preview'

test('shared preview consumes the preloaded session API response and draft overlay', async () => {
  let resolveDetail!: (value: unknown) => void
  const response = new Promise(resolve => { resolveDetail = resolve })
  const id = 'AK.preview-ready'
  const previewCard = { ...card, id }
  const previewProposed = { ...proposed, id }
  const previewBatch = { ...detail(), plates: [{ ...detail().plates[0], proposed: previewProposed }] }
  session.api.get.mockImplementation((key: string) => key === '/api/plates/' + id ? response : Promise.resolve(key === ownKey ? [batch] : previewBatch))
  const scope = harness()
  const preload = renderHook(() => usePreloadPlateDetail(), scope)
  act(() => preload.result.current(id))
  const anchor = document.createElement('span')
  document.body.append(anchor)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const view = render(createElement(ReadyPlatePreview, { plate: previewCard, anchor, immediate: false, checkKey: 'description' }), scope)
  expect(document.querySelector('[data-check-tooltip]')).toBeNull()
  await act(async () => { resolveDetail({ plate: previewCard, family: [], prevId: null, nextId: null }); await response })
  await waitFor(() => expect(document.querySelector('[data-check-tooltip]')?.textContent).toContain(proposed.description))
  expect(session.api.get.mock.calls.filter(([key]) => key === '/api/plates/' + id)).toHaveLength(1)
  view.unmount()
  anchor.remove()
  vi.unstubAllGlobals()
})

test.each([
  ['publish_disabled_here', 'Publishing is disabled in this environment.'],
  ['superseded_revision', 'This Batch changed since approval and must be re-approved.'],
  ['not_waiting', 'This run is no longer waiting for Publish. Refresh to see its status.'],
  ['forbidden', 'Only the Owner can Publish.'],
  ['not_found', 'This Batch could not be found.'],
])('Publish maps %s and posts the approved revision', async (code, message) => {
  session.api.send.mockRejectedValue(new ApiError(409, code, {}))
  const { result } = renderHook(() => useReviewActions(), harness())
  await act(async () => expect(await result.current.publish('approved', 7)).toEqual({ ok: false, message }))
  expect(session.api.send).toHaveBeenCalledWith('POST', '/api/batches/approved/publish', { revision: 7 })
})

test('Editor never requests run status', async () => {
  session.api.get.mockResolvedValue({ role: 'editor' })
  const { result } = renderHook(() => useBatchRun('restricted'), harness())
  await waitFor(() => expect(session.api.get).toHaveBeenCalledWith('/api/me'))
  expect(result.current.data).toBeUndefined()
  expect(session.api.get).not.toHaveBeenCalledWith('/api/batches/restricted/run')
})

test.each(['published', 'failed'])('Publish polls through delayed start and stops at %s', async terminal => {
  let phase = 'waiting-for-publish'
  const id = `poll-${terminal}`
  const key = `/api/batches/${id}/run`
  session.api.get.mockImplementation(async (key: string) => key === '/api/me' ? { role: 'owner' } : { phase, runId: id, outcome: null, updatedAt: null })
  session.api.send.mockResolvedValue({ status: 'publishing' })
  const { result } = renderHook(() => ({ run: useBatchRun(id), actions: useReviewActions() }), harness())
  await waitFor(() => expect(result.current.run.data?.phase).toBe('waiting-for-publish'))
  vi.useFakeTimers()
  try {
    await act(async () => expect(await result.current.actions.publish(id, 7)).toEqual({ ok: true }))
    phase = 'publishing'
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    expect(result.current.run.data?.phase).toBe('publishing')
    phase = terminal
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    expect(result.current.run.data?.phase).toBe(terminal)
    const count = session.api.get.mock.calls.filter(([path]) => path === key).length
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(session.api.get.mock.calls.filter(([path]) => path === key)).toHaveLength(count)
  } finally { vi.useRealTimers() }
})

test('Publish confirmation shows the approved revision, sends the current batch revision and retains its result when lists refresh', async () => {
  let published = false
  const approved = { ...batch, id: 'release', name: 'Veterans release', state: 'approved', revision: 8, approval: { by: 'owner', revision: 7, at: '2026-11-16T12:00:00Z' } }
  const other = { ...approved, id: 'other', name: 'Other release', approval: { ...approved.approval, at: '2026-11-15T12:00:00Z' } }
  session.api.get.mockImplementation(async (key: string) => {
    if (key === '/api/me') return { role: 'owner' }
    if (key.endsWith('/run')) return { phase: published ? 'published' : 'waiting-for-publish', runId: 'release-run', outcome: published ? { version: 12 } : null, updatedAt: null }
    if (key.includes('?')) return [{ ...approved, state: published ? 'published' : 'approved' }, other]
    return { batch: { ...approved, state: published ? 'published' : 'approved' }, plates: detail().plates }
  })
  session.api.send.mockImplementation(async () => { published = true; return { status: 'publishing' } })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } })
  try {
    render(createElement(PublishWorkspace), harness())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish revision 7' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Publish revision 7' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Publish Veterans release?')
    expect(dialog.textContent).toContain('This creates the next Catalog Snapshot.')
    expect(dialog.textContent).toContain('edited')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish revision 7' }))
    await waitFor(() => expect(screen.getByText(/Published as Snapshot/)).toBeDefined())
    expect(session.api.send).toHaveBeenCalledExactlyOnceWith('POST', '/api/batches/release/publish', { revision: 8 })
    expect(screen.getByText('v12')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Publish revision 7' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Veterans release' })).toBeDefined()
  } finally { Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close') }
})
