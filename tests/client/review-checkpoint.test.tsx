// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useReviewCheckpoint } from '../../lib/client/review-checkpoint'

const session = vi.hoisted(() => ({
  user: { uid: 'owner' },
  api: { get: vi.fn(), send: vi.fn() },
}))
vi.mock('../../lib/client/session', () => ({ useSession: () => session }))

beforeEach(() => {
  session.api.send.mockReset().mockResolvedValue({})
})
afterEach(cleanup)

test('Review records a checkpoint for the shared draft and never for a history Batch or release', () => {
  renderHook(() => useReviewCheckpoint('shared-draft-test', 4, true))
  expect(session.api.send).toHaveBeenCalledExactlyOnceWith(
    'POST',
    '/api/batches/shared-draft-test/review-checkpoint',
    { revision: 4 }
  )
  session.api.send.mockClear()
  renderHook(() => useReviewCheckpoint('old-batch', 4, true))
  renderHook(() => useReviewCheckpoint('release-0123abcd', 2, true))
  expect(session.api.send).not.toHaveBeenCalled()
})
