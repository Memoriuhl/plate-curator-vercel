vi.mock('../components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span role="tooltip">{children}</span>,
}))
import { filterCounts } from '../components/dashboard/family-data'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, test, vi } from 'vitest'
import { BatchActions } from '../components/dashboard/batch-actions'
import { ReviewStrip } from '../components/dashboard/review-strip'
import { FilterBar } from '../components/dashboard/filter-bar'
import { alaskaFixture } from '../fixtures/dashboard-frame'
import type { BatchDetail } from '../lib/client/hooks'
import type { ReviewBatch } from '../lib/review/types'

const state = vi.hoisted(() => ({
  selected: false,
  readonly: false,
  role: 'owner',
  open: [] as ReviewBatch[],
  review: [] as ReviewBatch[],
  detail: undefined as BatchDetail | undefined,
  submit: vi.fn(),
  buttons: new Map<
    string,
    { disabled?: boolean; 'aria-disabled'?: boolean | 'true' | 'false'; onClick?: () => Promise<void> }
  >(),
}))

vi.mock('../lib/client/hooks', () => ({
  useTaggingModels: () => ({ data: undefined }),
  useWorkspaceBatch: () => state.selected ? ({ mode: 'selected', id: 'shared', detail: state.detail, status: state.readonly ? 'read-only' : 'ready' }) : ({ mode: 'personal' }),
  useEnsureBatch: () => vi.fn(),
  useEditPlate: () => ({ edit: vi.fn(), pending: false }),
  useMe: () => ({ data: { uid: 'Jonathan', role: state.role } }),
  useBatches: (states: string[]) => ({
    data: states.includes('open') ? state.open : state.review,
  }),
  useBatch: () => ({ data: state.detail }),
  useReviewActions: () => ({ submit: state.submit }),
}))
vi.mock('../lib/client/session', () => ({
  useSession: () => ({ api: { get: vi.fn(), send: vi.fn() } }),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/states/AK',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('../components/ui/button', () => ({
  Button: (props: ComponentProps<'button'>) => {
    const label = Array.isArray(props.children)
      ? props.children.filter((child) => typeof child === 'string').join('')
      : String(props.children)
    state.buttons.set(
      label,
      props as { disabled?: boolean; onClick?: () => Promise<void> },
    )
    return <button disabled={props.disabled} aria-label={props['aria-label']} aria-disabled={props['aria-disabled']} title={props.title}>{props.children}</button>
  },
}))

const batch: ReviewBatch = {
  stateOrders: {},
  id: 'batch-one',
  name: 'Alaska updates',
  createdBy: 'Jonathan',
  createdByName: null,
  state: 'open',
  revision: 7,
  createdAt: '2026-11-16',
  baselineVersion: 11,
  approval: null,
  plateIds: ['AK.standard_gold', 'AK.amateur_radio_call_sign', 'AZ.standard'],
}

beforeEach(() => {
  state.selected = false
  state.readonly = false
  state.role = 'owner'
  state.open = [batch]
  state.review = []
  state.detail = {
    batch,
    plates: [
      {
        baseline: {
          id: 'AK.standard_gold',
          state: 'AK',
          tags: [],
          slug: 'standard_gold',
          displayName: 'Standard',
          image: '',
        },
        proposed: {
          id: 'AK.standard_gold',
          state: 'AK',
          tags: ['gold'],
          slug: 'standard_gold',
          displayName: 'Standard',
          image: '',
        },
        revision: 'r1',
        edit: {
          plateId: 'AK.standard_gold',
          baseRevision: 'r0',
          fields: { tags: ['gold'] },
          authorId: 'Jonathan',
          updatedAt: '2026-11-16',
          resultRevision: 'r1',
        },
      },
    ],
  } as BatchDetail
  state.buttons.clear()
  state.submit.mockReset()
})

test('submit sends the loaded batch revision and counts edits', async () => {
  const html = renderToStaticMarkup(
    <BatchActions underTagged={[]} stateCode="AK" stateName="Alaska" />,
  )
  expect(html).toContain('1 changes, saved')
  const submit = state.buttons.get('Submit for review')!
  expect(submit.disabled).toBe(false)
  await submit.onClick!()
  expect(state.submit).toHaveBeenCalledWith('batch-one', 7)
})

test('editors see disabled Publish and can open the pipeline menu', () => {
  state.role = 'editor'
  const html = renderToStaticMarkup(
    <BatchActions underTagged={[]} stateCode="AK" stateName="Alaska" />,
  )
  expect(html).toContain('Only Owners can publish')
  expect(state.buttons.get('Publish to players')?.['aria-disabled']).toBe('true')
  expect(state.buttons.get('Run pipeline')?.disabled).not.toBe(true)
})

test.each([false, true])('Owner cannot publish or submit an empty Batch with pipeline history %s', hasPipelineHistory => {
  const plate = state.detail!.plates[0]
  plate.proposed = plate.baseline
  plate.edit = hasPipelineHistory ? { ...plate.edit!, fields: {}, pipelineRunIds: ['historical-run'] } : null
  renderToStaticMarkup(
    <BatchActions underTagged={[]} stateCode="AK" stateName="Alaska" />,
  )
  expect(state.buttons.get('Publish to players')?.['aria-disabled']).toBe('true')
  expect(state.buttons.get('Submit for review')?.disabled).toBe(true)
})

test('no open batch hides the batch summary and disables submit', () => {
  state.open = []
  state.detail = undefined
  const html = renderToStaticMarkup(
    <BatchActions underTagged={[]} stateCode="AK" stateName="Alaska" />,
  )
  expect(html).not.toContain('Your batch:')
  expect(state.buttons.get('Submit for review')?.disabled).toBe(true)
})

test('review strip hides when empty and approved batches retain Review with enabled Publish', () => {
  expect(renderToStaticMarkup(<ReviewStrip />)).toBe('')
  state.review = [{ ...batch, state: 'approved' }]
  const html = renderToStaticMarkup(<ReviewStrip />)
  expect(html).toContain('href="/review?batch=batch-one"')
  expect(html).toContain('Approved')
  expect(html).toContain('Rev 7')
  expect(html).toContain('href="/publish?batch=batch-one"')
  expect(state.buttons.get('Publish to players')?.disabled).not.toBe(true)
})

test.each([0, 1, 3])('review strip pluralizes %i plates and uses body typography', (count) => {
  state.review = [{ ...batch, state: 'submitted', plateIds: batch.plateIds.slice(0, count) }]
  const html = renderToStaticMarkup(<ReviewStrip />)
  expect(html).toContain(`>${count} ${count === 1 ? 'plate' : 'plates'}<`)
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap(([, value]) => value.split(/\s+/))
  expect(classes).not.toContain('count')
  expect(classes).not.toContain('font-mono')
  expect(html.indexOf('review-plate-count')).toBeLessThan(html.indexOf('review-status'))
  expect(html.indexOf('review-status')).toBeLessThan(html.indexOf('review-actions'))
})

test('review strip preserves the full state list in its title', () => {
  const states = ['AK', 'AL', 'AZ', 'CA', 'CO', 'VT']
  state.review = [{ ...batch, state: 'submitted' }]
  state.detail!.plates = states.map(code => ({
    ...state.detail!.plates[0],
    baseline: { ...state.detail!.plates[0].baseline, state: code },
  }))
  const html = renderToStaticMarkup(<ReviewStrip />)
  const list = states.join(', ')
  expect(html).toContain(`<strong class="review-states" title="${list}">${list}</strong>`)
})

test('changed filter counts current-jurisdiction batch membership including unedited plates', () => {
  const html = renderToStaticMarkup(
    <FilterBar counts={filterCounts(alaskaFixture.plates)} code="AK" />,
  )
  expect(html).toMatch(/Changed in a batch<span class="count">2<\/span>/)
})


test('selected submit targets the shared Batch and Run Tag is available', async () => {
  state.selected = true
  state.detail!.batch = { ...batch, id: 'shared', revision: 9 }
  const html = renderToStaticMarkup(<BatchActions underTagged={[]} stateCode="AK" stateName="Alaska" />)
  expect(html).toContain('Selected batch:')
  expect(state.buttons.get('Run pipeline')?.disabled).toBe(false)
  await state.buttons.get('Submit for review')!.onClick!()
  expect(state.submit).toHaveBeenCalledWith('shared', 9)
})

test('read-only shared Batch cannot submit', async () => {
  state.selected = true
  state.readonly = true
  renderToStaticMarkup(<BatchActions underTagged={[]} stateCode="AK" stateName="Alaska" />)
  expect(state.buttons.get('Submit for review')?.disabled).toBe(true)
  await state.buttons.get('Submit for review')!.onClick!()
  expect(state.submit).not.toHaveBeenCalled()
})
