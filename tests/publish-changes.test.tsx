// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import {
  BatchChanges,
  changesByState,
} from '../components/publish/batch-changes'
vi.mock('../lib/client/live-signal', () => ({
  useBatchRevisionSignal: () => 'Live',
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  // Open the Batch from Publish history; without a link Publish shows the shared draft.
  useSearchParams: () => new URLSearchParams('batch=published'),
}))

import { PublishWorkspace } from '../components/publish/workspace'
import type { BatchDetail } from '../lib/client/hooks'

const status = vi.hoisted(() => ({
  value: 'published',
  version: 16 as number | undefined,
  retry: false,
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  status.value = 'published'
  status.version = 16
  status.retry = false
})
const baseline = {
  id: 'AK.one',
  state: 'AK',
  slug: 'one',
  displayName: 'One',
  image: 'one.webp',
  tags: [],
}
const entry = {
  baseline,
  proposed: { ...baseline, description: 'New' },
  edit: null,
  revision: 'r',
  beforeImageUrl: '/one.webp',
  order: { before: 0, after: 1, total: 2 },
}
const batch = {
  baselineVersion: 1,
  revision: 2,
  stateOrders: {},
} as BatchDetail['batch']

test('groups unique changed plates by state with all applicable tags', () => {
  const groups = changesByState([
    entry,
    { ...entry, baseline: { ...baseline, id: 'KS.one', state: 'KS' } },
  ])
  expect(groups.map((group) => group.code)).toEqual(['AK', 'KS'])
  expect(groups[0].plates).toHaveLength(1)
  expect(groups[0].plates[0].tags).toEqual(['Edited', 'Reordered'])
  expect(
    changesByState([{ ...entry, proposed: baseline, order: undefined }])
  ).toEqual([])
})

test('state and plate chevrons expand on demand with lazy thumbnails', () => {
  const view = render(<BatchChanges plates={[entry]} batch={batch} />)
  expect(screen.queryByRole('button', { name: /One/ })).toBeNull()
  expect(view.container.querySelector('img')?.getAttribute('loading')).toBe(
    'lazy'
  )
  const stateToggle = screen.getByRole('button', { name: /AK Alaska/ })
  expect(stateToggle.hasAttribute('aria-controls')).toBe(false)
  fireEvent.click(stateToggle)
  expect(
    document.getElementById(stateToggle.getAttribute('aria-controls')!)
  ).toBeTruthy()
  const row = screen.getByRole('button', { name: /One/ })
  expect(row.getAttribute('aria-expanded')).toBe('false')
  expect(row.hasAttribute('aria-controls')).toBe(false)
  expect(row.textContent).toContain('description')
  expect(row.textContent).toContain('reordered: 1 \u2192 2')
  expect(screen.queryByText(/Before.*Catalog/)).toBeNull()
  fireEvent.click(row)
  expect(
    document.getElementById(row.getAttribute('aria-controls')!)
  ).toBeTruthy()
  expect(screen.getByText(/Before.*Catalog v1/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /AK Alaska/ }))
  expect(screen.queryByText(/Before.*Catalog/)).toBeNull()
})

vi.mock('../lib/client/hooks', () => ({
  /** Supply the current fixture actor for role and account-dependent behavior. */
  useMe: () => ({ data: { role: 'owner' } }),
  /** Supply the publish controls for the current workspace scenario. */
  usePublishControl: () => ({ data: { control: null }, change: vi.fn() }),
  /** Provide the batch list for the current workspace scenario. */
  useBatches: () => ({
    data: [
      {
        id: 'published',
        name: 'Autumn plates',
        state: status.value,
        createdAt: '2026-11-17',
        revision: 2,
        stateOrders: {},
      },
    ],
  }),
  /** Provide batch detail from the fixture in place of an SWR request. */
  useBatch: () => ({
    data: {
      batch: {
        id: 'published',
        name: 'Autumn plates',
        state: status.value,
        revision: 2,
        stateOrders: {},
        approval: status.retry ? { revision: 1 } : null,
      },
      plates: [{ ...entry, edit: { fields: { description: 'New' } } }],
    },
  }),
  /** Supply the workflow phase used by the fixture batch view. */
  useBatchRun: () => ({ data: { outcome: { version: status.version } } }),
  /** Supply the publish baseline and release eligibility under test. */
  usePublishBaseline: () => ({
    data: {
      error: null,
      canRetry: status.retry,
      enabledHere: true,
      batchRevision: 2,
      approvalProblems: [],
      confirmation: {
        revision: 2,
        since: null,
        plateCount: 0,
        contributors: [],
      },
    },
  }),
  /** Provide controllable batch actions so the test can inspect user requests. */
  useReviewActions: () => ({}),
  /** Name the shared draft listed above Publish history. */
  useSharedDraftId: () => 'shared-draft-test',
}))

test('published batch uses the catalog version as its visual anchor', () => {
  render(<PublishWorkspace />)
  const card = screen.getByRole('link', { name: /v16.*Autumn plates/ })
  expect(card.querySelector('.text-4xl')?.textContent).toBe('v16')
  expect(card.textContent).not.toContain('waiting')
})

test('large state groups mount only a window of plate rows', () => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(88)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(560)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  const plates = Array.from({ length: 250 }, (_, index) => ({
    ...entry,
    baseline: { ...baseline, id: `AK.${index}` },
    proposed: {
      ...entry.proposed,
      id: `AK.${index}`,
      displayName: `Plate ${index}`,
    },
  }))
  render(<BatchChanges plates={plates} batch={batch} />)
  fireEvent.click(screen.getByRole('button', { name: /AK Alaska/ }))
  const rows = screen.getAllByRole('button', { name: /Plate / })
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.length).toBeLessThan(30)
})

test('an invalid approval leaves the Publish button visible and disabled', () => {
  status.value = 'approved'
  render(<PublishWorkspace />)
  expect(
    screen.getByText(
      'This release no longer matches its confirmation. Publish the shared draft again.'
    )
  ).toBeTruthy()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Publish to Game' })
      .disabled
  ).toBe(true)
  expect(screen.queryByRole('button', { name: /Publish revision/ })).toBeNull()
})

test('published batch without a version uses a normal Published title', () => {
  status.version = undefined
  render(<PublishWorkspace />)
  const card = screen.getByRole('link', { name: /Published.*Autumn plates/ })
  expect(card.querySelector('.text-4xl')).toBeNull()
  expect(card.textContent).not.toContain('v?')
})

test('retry eligibility suppresses the current approval warning', () => {
  status.value = 'approved'
  status.retry = true
  render(<PublishWorkspace />)
  expect(screen.getByRole('button', { name: 'Publish again' })).toBeTruthy()
  expect(screen.queryByText(/needs current approval/)).toBeNull()
})

test('deleted plate thumbnails are dimmed and their names struck through', () => {
  const deleted = { ...entry, proposed: { ...entry.proposed, deleted: true } }
  const view = render(<BatchChanges plates={[deleted]} batch={batch} />)
  expect(
    view.container.querySelector('img')?.parentElement?.className
  ).toContain('opacity-60')
  fireEvent.click(screen.getByRole('button', { name: /AK Alaska/ }))
  const row = screen.getByRole('button', { name: /One/ })
  expect(row.querySelector('strong')?.className).toContain('line-through')
  expect(row.querySelector('img')?.parentElement?.className).toContain(
    'opacity-60'
  )
  expect(row.textContent).toContain('Deleted')
})
