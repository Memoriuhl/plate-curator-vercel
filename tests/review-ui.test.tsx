import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { changeSummary, DiffTable } from '../components/review/diff'
import {
  ReviewFooter,
  ReviewWorkspace,
  reviewError,
  reviewHref,
} from '../components/review/workspace'
import type { BatchDetail } from '../lib/client/hooks'
import type { Plate } from '../lib/catalog/types'

const state = vi.hoisted(() => ({
  role: 'owner',
  query: '',
  detail: undefined as BatchDetail | undefined,
  approve: vi.fn(),
  submit: vi.fn(),
  mutate: vi.fn(),
  buttons: new Map<string, ComponentProps<'button'>>(),
}))
vi.mock('../lib/client/hooks', () => ({
  useBatchRun: () => ({ data: { phase: 'published', outcome: { version: 12 } } }),
  useMe: () => ({ data: { uid: 'author', role: state.role } }),
  useBatches: () => ({ data: [] }),
  useBatch: () => ({ data: state.detail, mutate: state.mutate }),
  useReviewActions: () => ({ approve: state.approve, submit: state.submit }),
}))
vi.mock('../lib/client/review-checkpoint', () => ({ useReviewCheckpoint: vi.fn(), useRecentReviewPlates: () => ({}) }))
vi.mock('../lib/client/session', () => ({
  useSession: () => ({ user: { displayName: 'Author' } }),
}))
vi.mock('../components/ui/button', () => ({
  Button: (props: ComponentProps<'button'>) => {
    const label = Array.isArray(props.children)
      ? props.children.filter((child) => typeof child === 'string').join('')
      : String(props.children)
    state.buttons.set(label, props)
    return <button disabled={props.disabled}>{props.children}</button>
  },
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(state.query),
  useRouter: () => ({ replace: vi.fn() }),
}))
const before: Plate = {
  id: 'AK.army',
  state: 'AK',
  slug: 'army',
  image: 'AK/army.webp',
  displayName: 'Army',
  description: 'Old description',
  tags: ['soldier', 'veteran'],
  templateFamily: 'army',
  templateRole: 'template',
  sortOrder: 0,
}
const after: Plate = {
  ...before,
  image: 'AK/new.webp',
  displayName: 'New Army',
  description: 'New description',
  tags: ['veteran', 'service'],
  templateFamily: 'veterans',
  templateRole: 'variant',
  sortOrder: 1,
  isStandard: true,
  sourceUrl: 'reference',
}
const detail: BatchDetail = {
  batch: {
    stateOrders: {},
    id: 'one',
    name: 'Updates',
    createdBy: 'author',
    createdByName: 'Alex',
    createdAt: '',
    state: 'submitted',
    revision: 4,
    baselineVersion: 41,
    plateIds: [before.id],
    approval: null,
  },
  plates: [{ baseline: before, proposed: after, edit: null, revision: 'r' }],
}
beforeEach(() => {
  state.role = 'owner'
  state.query = ''
  state.detail = undefined
  state.buttons.clear()
  state.approve.mockReset()
  state.submit.mockReset()
  state.mutate.mockReset().mockResolvedValue(detail)
})
test.each(['open', 'submitted'] as const)('Review summarizes %s Batches without Publish actions', status => {
  const html = renderToStaticMarkup(<ReviewFooter detail={{ ...detail, batch: { ...detail.batch, state: status } }} />)
  expect(html).toContain('1 changed plate · rev 4')
  expect(html).toContain(status === 'open' ? 'Submit for review' : 'Approve revision 4')
  expect(html).not.toContain('Publish to players')
})
test('summaries describe fields, family and standard changes', () => {
  expect(changeSummary(before, after)).toBe(
    'image, name, description, tags, moved to veterans, role, order, now Standard, links',
  )
  expect(changeSummary(before, before)).toBe('No changes')
})
test('table renders every field kind, tags diff and unchanged values in order', () => {
  const html = renderToStaticMarkup(
    <DiffTable
      before={before}
      after={after}
      version={41}
      revision={4}
      order={[before.id, 'AK.other']}
    />,
  )
  for (const value of [
    'Image',
    'Name',
    'Description',
    'Tags',
    'Family',
    'Role',
    'Order',
    'Standard',
    'Rarity',
    'Fun facts',
    'Links',
    'soldier',
    'service',
    '1 of 2',
    '2 of 2',
    'not available',
    'none',


    'success-tint',
  ])
    expect(html).toContain(value)
  expect(html).toContain('Before · Catalog v41')
  expect(html).toContain('After · rev 4')
})
test('Review retains existing approval metadata', () => {
  const html = renderToStaticMarkup(
    <ReviewFooter
      detail={{
        ...detail,
        batch: {
          ...detail.batch,
          state: 'approved',
          approval: { by: 'owner', at: 'today', revision: 4 },
        },
      }}
    />,
  )
  expect(html).toContain('Approved by an Owner on today')
  expect(html).not.toContain('Request changes')
})
test('superseded and invalid state errors explain recovery', () => {
  expect(reviewError({ code: 'superseded_revision' }, 5)).toBe(
    'This batch changed while you were reviewing. Look again at revision 5.',
  )
  expect(reviewError({ code: 'invalid_state' }, 4)).toContain('Refresh')
})
test('empty state links to dashboard and selection links preserve URL state', () => {
  const html = renderToStaticMarkup(
    <ReviewWorkspace states={[{ code: 'AK', name: 'Alaska', plates: [] }]} />,
  )
  expect(html).toContain('Nothing waiting for review')
  expect(html).toContain('href="/"')
  expect(html).not.toContain('href="/review?state=AK"')
  expect(reviewHref('AK', 'AK.army', 'batch id')).toBe(
    '/review?state=AK&plate=AK.army&batch=batch+id',
  )
})
test('URL state, plate and batch select the requested comparison', () => {
  state.query = 'state=AK&plate=AK.army&batch=one'
  state.detail = detail
  const html = renderToStaticMarkup(
    <ReviewWorkspace
      states={[
        {
          code: 'AK',
          name: 'Alaska',
          plates: [
            { id: before.id, displayName: before.displayName, imageUrl: null },
          ],
        },
      ]}
    />,
  )
  expect(html).toContain('New Army')
  expect(html).toContain('After · rev 4')
  expect(html).toContain('1 changed plate · rev 4')
  expect(html).toContain(
    'href="/review?state=AK&amp;plate=AK.army&amp;batch=one"',
  )
  expect(html).not.toContain('Nothing waiting for review')
})

test('the footer keeps the whole Batch revision and summarizes the changed plates', () => {
  const kansas = { ...before, id: 'KS.army', state: 'KS' }
  const multi: BatchDetail = {
    ...detail,
    batch: {
      ...detail.batch,
      name: 'Veterans updates',
      plateIds: [before.id, kansas.id],
    },
    plates: [
      ...detail.plates,
      { baseline: kansas, proposed: kansas, edit: null, revision: 'ks' },
    ],
  }
  const html = renderToStaticMarkup(<ReviewFooter detail={multi} />)
  expect(html).toContain('1 changed plate · rev 4')
  expect(html).toContain('title="AK"')

})

test('the compact comparison and footer switch with the URL Batch', () => {
  const render = (selected: BatchDetail) => {
    state.detail = selected
    state.query = `state=AK&plate=AK.army&batch=${selected.batch.id}`
    return renderToStaticMarkup(
      <ReviewWorkspace states={[{ code: 'AK', name: 'Alaska', plates: [] }]} />,
    )
  }
  const named = render(detail)
  expect(named).toContain('Updates')
  expect(named).toContain('1 changed plate · rev 4')
  expect(named).not.toContain('Updates · by Alex')
  const older = render({
    ...detail,
    batch: {
      ...detail.batch,
      id: 'two',
      name: 'Older batch',
      revision: 8,
      createdByName: null,
    },
  })
  expect(older).toContain('Older batch')
  expect(older).not.toContain('Older batch · by a curator')
  expect(older).toContain('1 changed plate · rev 8')
  expect(older).not.toContain('by Alex')
})

test('review shows reordered plates with canonical old and new positions', () => {
  const order = { before: 2, after: 0, total: 5 }
  const reordered: BatchDetail = {
    ...detail,
    batch: { ...detail.batch, stateOrders: { AK: [before.id, 'AK.other'] } },
    plates: [{ baseline: before, proposed: before, edit: null, revision: 'r', order }],
  }
  state.query = 'state=AK&plate=AK.army&batch=one'
  state.detail = reordered
  const html = renderToStaticMarkup(<ReviewWorkspace states={[{ code: 'AK', name: 'Alaska', plates: [] }]} />)
  expect(html).toContain('reordered: 3 → 1')
  expect(html).toContain('3 of 5')
  expect(html).toContain('1 of 5')
})

test('review describes a cleared variant link', () => {
  const variant = { ...before, templateRole: 'variant' as const, variantOfPlateId: 'AK.parent' }
  const detached = { ...variant, templateRole: 'template' as const, templateFamily: variant.id, variantOfPlateId: null }
  expect(changeSummary(variant, detached)).toContain('variant link cleared')
  const html = renderToStaticMarkup(<DiffTable before={variant} after={detached} version={41} revision={5} order={[variant.id]} />)
  expect(html).toContain('Variant of')
  expect(html).toContain('AK.parent')
  expect(html).toContain('cleared')
})

test('published Batch is read-only with its Snapshot version', () => {
  const html = renderToStaticMarkup(<ReviewFooter detail={{ ...detail, batch: { ...detail.batch, state: 'published' } }} />)
  expect(html).toContain('Published · v12')
  expect(html).not.toContain('Request changes')
  expect(html).not.toContain('Approve revision')
  expect(html).not.toContain('Submit for review')
})

test('cards repeat unchanged values without tint and highlight only changed values and chips', () => {
  const html = renderToStaticMarkup(<DiffTable before={before} after={{ ...before, description: 'Updated', tags: ['veteran', 'service'] }} version={41} revision={4} order={[before.id]} beforeImageUrl="/plate.webp" />)
  const [left, right] = html.split('<section').slice(1)
  for (const card of [left, right]) {
    expect(card).toContain('>Army</span>')
    expect(card).toContain('bg-[var(--fill)]">veteran</span>')
    expect(card).toContain('src="/plate.webp"')
    expect(card).not.toContain('unchanged')
    expect(card).not.toContain('line-through')
  }
  expect(left).toContain('bg-[var(--danger-tint)]">Old description</span>')
  expect(right).toContain('bg-[var(--success-tint)]">Updated</span>')
  expect(left).toContain('bg-[var(--danger-tint)]">soldier</span>')
  expect(right).toContain('bg-[var(--success-tint)]">service</span>')
  expect(left).not.toContain('success-tint')
  expect(right).not.toContain('danger-tint')
})

test('changed image keeps live preview and names proposed file unless a URL is supplied', () => {
  const html = renderToStaticMarkup(<DiffTable before={before} after={after} version={41} revision={4} order={[before.id]} beforeImageUrl="/plate.webp" />)
  expect(html).toContain('ring-[var(--danger)]')
  expect(html).toContain('ring-[var(--success)]')
  expect(html).toContain('AK/new.webp')
  expect(html.split('src="/plate.webp"')).toHaveLength(2)
})

test('review submission errors show every affected state', async () => {
  const { ApiError } = await import('../lib/client/api')
  const reasons = ['AK: make Gold the Standard.', 'NY: make Blue the Standard.']
  expect(reviewError(new ApiError(409, 'standard_change_unconfirmed', { reasons }), 1)).toBe(reasons.join(' '))
})

test('a run History link lists just the changed plates from that run across states', () => {
  const kansas = { ...before, id: 'KS.sesquicentennial', state: 'KS', displayName: 'Sesquicentennial' }
  const virginia = { ...before, id: 'VA.dogwood', state: 'VA', displayName: 'Dogwood' }
  state.query = 'batch=one&run=mountain'
  state.detail = {
    ...detail,
    plates: [
      ...detail.plates.map(plate => ({ ...plate, edit: { plateId: before.id, baseRevision: 'a', resultRevision: 'b', fields: { tags: ['service'] }, authorId: 'author', updatedAt: '', pipelineRunIds: ['mountain'] } })),
      { baseline: kansas, proposed: { ...kansas, tags: ['prairie'] }, edit: { plateId: kansas.id, baseRevision: 'a', resultRevision: 'b', fields: { tags: ['prairie'] }, authorId: 'author', updatedAt: '', pipelineRunIds: ['mountain'] }, revision: 'ks' },
      { baseline: virginia, proposed: { ...virginia, tags: ['flower'] }, edit: { plateId: virginia.id, baseRevision: 'a', resultRevision: 'b', fields: { tags: ['flower'] }, authorId: 'author', updatedAt: '', pipelineRunIds: ['coastal'] }, revision: 'va' },
    ],
  }
  const html = renderToStaticMarkup(<ReviewWorkspace states={[
    { code: 'AK', name: 'Alaska', plates: [] }, { code: 'KS', name: 'Kansas', plates: [] }, { code: 'VA', name: 'Virginia', plates: [] },
  ]} />)
  expect(html).toContain('Sesquicentennial')
  expect(html).toContain('state=KS&amp;plate=KS.sesquicentennial&amp;batch=one&amp;run=mountain')
  expect(html).not.toContain('Dogwood')
})
