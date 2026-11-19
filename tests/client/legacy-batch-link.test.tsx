// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { WorkspaceTabs } from '../../components/app/workspace-tabs'
import { LegacyBatchLink } from '../../components/review/legacy-batch-link'
import { ApiError } from '../../lib/client/api'
import type { ReviewBatch } from '../../lib/review/types'

const mocks = vi.hoisted(() => ({
  pathname: '/review',
  query: '',
  replace: vi.fn(),
  batch: undefined as Partial<ReviewBatch> | undefined,
  error: undefined as Error | undefined,
  requested: [] as (string | null)[],
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mocks.query),
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: mocks.replace }),
}))
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.PropsWithChildren<object>) => (
    <a {...props}>{children}</a>
  ),
}))
vi.mock('../../lib/client/hooks', () => ({
  useMe: () => ({ data: { role: 'owner' } }),
  /** Serve the linked Batch (or its load error) in place of the request. */
  useBatch: (id: string | null) => {
    mocks.requested.push(id)
    return {
      data: id && mocks.batch ? { batch: mocks.batch, plates: [] } : undefined,
      error: id ? mocks.error : undefined,
    }
  },
}))

/** Open a URL and render the link resolver on it. */
function open(url: string, batch?: Partial<ReviewBatch>, error?: Error) {
  const [pathname, query = ''] = url.split('?')
  mocks.pathname = pathname
  mocks.query = query
  mocks.batch = batch
  mocks.error = error
  return render(<LegacyBatchLink />)
}

beforeEach(() => {
  mocks.replace.mockReset()
  mocks.requested = []
})
afterEach(cleanup)

test.each([
  ['folded', { state: 'folded', foldedInto: 'shared-draft-test' }],
  ['still open', { state: 'open' }],
  ['submitted', { state: 'submitted' }],
])(
  'a bookmarked Review link to a %s old Batch opens the shared draft with a notice',
  (_name, batch) => {
    open(
      '/review?batch=old&state=AK&plate=AK.one',
      batch as Partial<ReviewBatch>
    )
    expect(mocks.replace).toHaveBeenCalledWith(
      '/review?state=AK&plate=AK.one&oldBatch=1'
    )
  }
)

test('a link to a Batch that no longer exists opens the shared draft with a notice', () => {
  open(
    '/states/AK?batch=gone&plate=AK.one',
    undefined,
    new ApiError(404, 'not_found', {})
  )
  expect(mocks.replace).toHaveBeenCalledWith(
    '/states/AK?plate=AK.one&oldBatch=1'
  )
})

test('a Dashboard link to a published Batch or a release opens it read-only in Review', () => {
  open('/states/AK?batch=shipped&plate=AK.one', { state: 'published' })
  expect(mocks.replace).toHaveBeenLastCalledWith(
    '/review?state=AK&plate=AK.one&batch=shipped'
  )
  cleanup()
  open('/states/AL?batch=release-1', { kind: 'release', state: 'approved' })
  expect(mocks.replace).toHaveBeenLastCalledWith(
    '/review?state=AL&batch=release-1'
  )
})

test('Review keeps history links where they are', () => {
  open('/review?batch=shipped', { state: 'published' })
  open('/review?batch=release-1', { kind: 'release', state: 'published' })
  open('/review?batch=stuck', { state: 'conflict' })
  expect(mocks.replace).not.toHaveBeenCalled()
})

test('shared draft links, plain URLs and other pages are left alone without loading a Batch', () => {
  open('/review?batch=draft')
  open('/states/AK?batch=shared-draft-test')
  open('/review')
  open('/publish?batch=old', { state: 'folded' })
  expect(mocks.requested.every((id) => id === null)).toBe(true)
  expect(mocks.replace).not.toHaveBeenCalled()
})

test('the notice explains where the changes went and can be dismissed', () => {
  open('/review?state=AK&oldBatch=1')
  expect(screen.getByRole('status').textContent).toMatch(
    /old Batch.*now in the shared draft/
  )
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(mocks.replace).toHaveBeenCalledWith('/review?state=AK')
})

test('a load error other than not found leaves the link as it is', () => {
  open('/review?batch=old', undefined, new ApiError(503, 'unavailable', {}))
  expect(mocks.replace).not.toHaveBeenCalled()
})

test('the Dashboard tab from a history view opens the shared draft, not the history again', () => {
  mocks.pathname = '/review'
  mocks.query = 'batch=release-1'
  render(<WorkspaceTabs />)
  expect(
    screen.getByRole('tab', { name: 'Dashboard' }).getAttribute('href')
  ).toBe('/')
  expect(
    screen.getByRole('tab', { name: 'Publish' }).getAttribute('href')
  ).toBe('/publish?batch=release-1')
})
