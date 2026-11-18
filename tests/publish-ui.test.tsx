import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, test, vi } from 'vitest'
import { groupChanges, changeSummary } from '../components/review/diff'
import { RunStatusView } from '../components/review/run-status'
import { PublishWorkspace } from '../components/publish/workspace'
import { TooltipProvider } from '../components/ui/tooltip'
import { WorkspaceTabs } from '../components/app/workspace-tabs'
import type { BatchDetail } from '../lib/client/hooks'

const state = vi.hoisted(() => ({
  role: 'owner',
  query: '',
  batches: [] as import('../lib/review/types').ReviewBatch[],
  selected: [] as string[],
}))
beforeEach(() => {
  state.role = 'owner'
  state.query = ''
  state.batches = []
  state.selected = []
})
vi.mock('../lib/client/hooks', () => ({
  /** Supply the publish controls for the current workspace scenario. */
  usePublishControl: () => ({
    data: { control: null },
    change: async () => {},
  }),
  /** Supply the current fixture actor for role and account-dependent behavior. */
  useMe: () => ({ data: { role: state.role } }),
  /** Supply the publish baseline and release eligibility under test. */
  usePublishBaseline: () => ({}),
  /** Supply the workflow phase used by the fixture batch view. */
  useBatchRun: () => ({}),
  /** Provide batch detail from the fixture in place of an SWR request. */
  useBatch: (id: string) => {
    state.selected.push(id)
    return {}
  },
  /** Provide the batch list for the current workspace scenario. */
  useBatches: () => ({ data: state.batches }),
  /** Provide controllable batch actions so the test can inspect user requests. */
  useReviewActions: () => ({}),
}))
vi.mock('../lib/client/live-signal', () => ({
  useBatchRevisionSignal: () => 'Live',
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/publish',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.query),
}))

test('groups field edits, cleared variants and reorders across States', () => {
  const baseline = {
    id: 'AK.a',
    state: 'AK',
    displayName: 'A',
    image: 'a.webp',
    slug: 'a',
    tags: [],
    variantOfPlateId: 'AK.parent',
  }
  const plates = [
    {
      baseline,
      proposed: { ...baseline, description: 'New', variantOfPlateId: null },
      order: { before: 6, after: 1, total: 8 },
    },
    {
      baseline: { ...baseline, id: 'KS.a', state: 'KS' },
      proposed: { ...baseline, id: 'KS.a', state: 'KS' },
      order: { before: 2, after: 0, total: 4 },
    },
  ].map((entry) => ({
    ...entry,
    edit: null,
    revision: 'r',
  })) satisfies BatchDetail['plates']
  const groups = groupChanges(plates)
  expect(groups.Edited).toHaveLength(1)
  expect(groups.Regrouped).toHaveLength(1)
  expect(groups.Reordered.map((entry) => entry.baseline.state)).toEqual([
    'AK',
    'KS',
  ])
  expect(changeSummary(plates[0].baseline, plates[0].proposed)).toContain(
    'variant link cleared'
  )
})

test.each([
  'waiting-for-approval',
  'waiting-for-publish',
  'publishing',
  'published',
  'failed',
  'superseded',
  'timed-out',
  null,
] as const)('run status renders %s', (phase) => {
  const html = renderToStaticMarkup(
    <RunStatusView
      run={{
        phase,
        runId: 'run-example',
        updatedAt: null,
        outcome: {
          version: 12,
          error: 'invalid_snapshot',
          reasons: ['Missing Template', 'Invalid State order'],
        },
      }}
    />
  )
  if (phase === null) expect(html).toContain('Not submitted yet')
  else {
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('Copy run id')
    expect(html).toContain('aria-current="step"')
  }
  if (phase === 'published') expect(html).toContain('v12')
  if (phase === 'failed')
    for (const message of [
      'Snapshot could not pass validation',
      'Missing Template',
      'Invalid State order',
      'Fix the Batch and approve it again',
    ])
      expect(html).toContain(message)
  if (phase === 'superseded')
    expect(html).toContain('Edited after submission, so this run was replaced')
  if (phase === 'timed-out')
    expect(html).toContain('No decision before the time limit')
})

test('Owner sees Publish tab and empty state; Editor sees neither action nor tab', () => {
  state.role = 'owner'
  expect(
    renderToStaticMarkup(
      <TooltipProvider>
        <WorkspaceTabs />
      </TooltipProvider>
    )
  ).toContain('href="/publish"')
  expect(renderToStaticMarkup(<PublishWorkspace />)).toContain(
    'No Batches to publish.'
  )
  state.role = 'editor'
  expect(
    renderToStaticMarkup(
      <TooltipProvider>
        <WorkspaceTabs />
      </TooltipProvider>
    )
  ).not.toContain('href="/publish"')
  expect(renderToStaticMarkup(<PublishWorkspace />)).toContain(
    'Only the Owner can Publish.'
  )
})

test('an order field counts a selected move even when its numeric position stays the same', () => {
  const baseline = {
    id: 'AK.one',
    state: 'AK',
    slug: 'one',
    displayName: 'One',
    image: '',
    tags: [],
  }
  const entry = {
    baseline,
    proposed: baseline,
    edit: null,
    revision: 'r',
    order: { before: 1, after: 1, total: 3 },
  }
  expect(groupChanges([entry]).Reordered).toEqual([entry])
  expect(changeSummary(baseline, baseline, entry.order)).toContain(
    'reordered: 2 → 2'
  )
  expect(groupChanges([{ ...entry, order: undefined }]).Reordered).toEqual([])
})

test('pointer_moved directs the Owner to Copy instead of reapproving the old Batch', () => {
  const html = renderToStaticMarkup(
    <RunStatusView
      run={{
        runId: 'run',
        phase: 'failed',
        updatedAt: null,
        outcome: { error: 'pointer_moved' },
      }}
    />
  )
  expect(html).toContain(
    'Open Publish and copy to a new Batch for fresh review.'
  )
  expect(html).not.toContain('Fix the Batch and approve it again.')
})

test.each(['superseded', 'publish_not_enabled'])(
  'terminal %s preserves approval and explains that the Catalog did not advance',
  (error) => {
    const html = renderToStaticMarkup(
      <RunStatusView
        run={{
          runId: 'run',
          phase: 'failed',
          updatedAt: null,
          outcome: { error },
        }}
      />
    )
    expect(html).toContain('The Catalog did not advance.')
    expect(html).toContain('The Batch remains approved.')
    expect(html).not.toContain('Fix the Batch and approve it again.')
  }
)

test('revoked stop identifies requester and requires a fresh Publish by an active Owner', () => {
  const html = renderToStaticMarkup(
    <RunStatusView
      run={{
        runId: 'run',
        phase: 'failed',
        updatedAt: null,
        outcome: {
          error: 'revoked',
          requestedBy: {
            uid: 'requester',
            email: 'requester@example.com',
            authorityEpoch: 2,
          },
        },
      }}
    />
  )
  expect(html).toContain('revoked')
  expect(html).toContain('requester@example.com')
  expect(html).toContain('The Catalog did not advance.')
  expect(html).toContain('fresh Publish by an active Owner')
})

test.each([
  ['batch=older', 'older'],
  ['batch=missing', 'missing'],
  ['batch=published', 'published'],
  ['', 'newest'],
])(
  'Publish preserves an explicit Batch ID and defaults only without one: %s',
  (query, selected) => {
    state.query = query
    state.batches = [
      { id: 'newest', state: 'approved' as const, createdAt: '2026-11-17' },
      { id: 'older', state: 'approved' as const, createdAt: '2026-11-16' },
      { id: 'published', state: 'published' as const, createdAt: '2026-11-15' },
    ].map((batch) => ({
      ...batch,
      name: batch.id,
      createdBy: 'owner',
      createdByName: null,
      revision: 1,
      baselineVersion: 1,
      stateOrders: {},
      plateIds: [],
      approval: null,
    }))
    renderToStaticMarkup(<PublishWorkspace />)
    expect(state.selected).toEqual([selected])
  }
)
