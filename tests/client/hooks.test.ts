import { createElement, type ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ApiError } from '../../lib/client/api'
import type { Plate } from '../../lib/catalog/types'
import type { PlateCardData } from '../../lib/catalog/dashboard-types'
import type { ReviewBatch } from '../../lib/review/types'
import { batchesKey, useDraftOverlay, useEditPlate, useBatches, useBatch, usePlateDetail, useEnsureBatch, type BatchDetail } from '../../lib/client/hooks'

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
