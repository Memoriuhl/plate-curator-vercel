import type { AnchorHTMLAttributes } from 'react'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { plateCards } from '../fixtures/plate-cards'
import { PlatePage } from '../components/plate-page/plate-page'
import type { PlateCardData } from '../lib/catalog/dashboard-types'
import type { EditResult } from '../lib/client/hooks'
import { slimPlate, type PlatePageProps } from '../components/plate-page/types'

const state = vi.hoisted(() => ({
  edit: vi.fn(),
  mutate: vi.fn(),
  query: 'show=tags&q=army',
  pending: false,
  remote: null as PlateCardData | null,
  refreshed: false,
}))
vi.mock('../components/dashboard/selected-batch-bar', () => ({ SelectedBatchBar: () => null }))
vi.mock('../components/dashboard/plate-tag-actions', () => ({ PlateTagActions: () => null }))
vi.mock('swr', () => ({ useSWRConfig: () => ({ mutate: state.mutate }) }))
vi.mock('../lib/client/hooks', () => ({
  useEditPlate: () => ({ edit: state.edit, pending: state.pending }),
  useDraftOverlay: (plates: PlateCardData[]) =>
    plates.map((plate) => ({
      ...(state.refreshed && state.remote?.id === plate.id
        ? state.remote
        : plate),
      changedInBatch: state.refreshed,
    })),
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(state.query),
  useRouter: () => ({ back: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))
vi.mock('next/image', () => ({ default: () => <span /> }))

const army = plateCards.find((plate) => plate.id === 'AK.army')!
const props: PlatePageProps = {
  plate: {
    ...slimPlate(army),
    imageSize: { width: 320, height: 160 },
    description: 'Original story',
    sourceUrl: null,
    wikiUrl: null,
  },
  plates: plateCards.map(slimPlate),
  stateName: 'Alaska',
  prevId: 'AK.standard_gold',
  nextId: 'AK.air_force',
}
const description = () =>
  screen.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement
function change(label: string, value: string) {
  fireEvent.change(screen.getByRole('textbox', { name: label }), {
    target: { value },
  })
}
function saveDescription(value: string) {
  change('Description', value)
  fireEvent.keyDown(description(), { key: 'Enter', ctrlKey: true })
}
beforeEach(() => {
  state.query = 'show=tags&q=army'
  state.pending = false
  state.remote = null
  state.refreshed = false
  state.mutate.mockReset().mockImplementation(async () => {
    state.refreshed = true
  })
  state.edit.mockReset().mockResolvedValue({ ok: true })
})
afterEach(cleanup)

test('tags normalize on Enter, deduplicate, and remove individually', async () => {
  render(<PlatePage {...props} />)
  change('Add tag', '  NEW TAG  ')
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Add tag' }), {
    key: 'Enter',
  })
  await waitFor(() => expect(state.edit).toHaveBeenCalledTimes(1))
  expect(state.edit).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: army.id }),
    { tags: [...army.tags, 'new tag'] },
  )
  change('Add tag', army.tags[0])
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Add tag' }), {
    key: 'Enter',
  })
  expect(state.edit).toHaveBeenCalledTimes(1)
  fireEvent.click(
    screen.getByRole('button', { name: `Remove tag ${army.tags[0]}` }),
  )
  await waitFor(() =>
    expect(state.edit).toHaveBeenLastCalledWith(expect.anything(), {
      tags: army.tags.slice(1),
    }),
  )
})

test('description stays local until blur or Ctrl+Enter and clears with null', async () => {
  render(<PlatePage {...props} />)
  change('Description', 'Updated story')
  expect(state.edit).not.toHaveBeenCalled()
  fireEvent.keyDown(description(), { key: 'Enter', ctrlKey: true })
  await waitFor(() =>
    expect(state.edit).toHaveBeenLastCalledWith(expect.anything(), {
      description: 'Updated story',
    }),
  )
  change('Description', '')
  fireEvent.blur(description())
  await waitFor(() =>
    expect(state.edit).toHaveBeenLastCalledWith(expect.anything(), {
      description: null,
    }),
  )
})

test('description rejects overlong text without saving', () => {
  render(<PlatePage {...props} />)
  saveDescription('x'.repeat(2001))
  expect(state.edit).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain(
    '2000 characters or fewer',
  )
})

test('Standard sends the inverse value', async () => {
  render(<PlatePage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Set as Standard' }))
  await waitFor(() =>
    expect(state.edit).toHaveBeenCalledWith(expect.anything(), {
      isStandard: !army.isStandard,
    }),
  )
})

test('family plus sends the destination family and its template id', async () => {
  render(<PlatePage {...props} />)
  fireEvent.click(
    screen.getByRole('button', { name: 'Add Standard Gold to family' }),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Add to family' }))
  await waitFor(() =>
    expect(state.edit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'AK.standard_gold' }),
      {
        templateFamily: army.templateFamily,
        templateRole: 'variant',
        variantOfPlateId: army.id,
      },
    ),
  )
})

test('a family without a template allows a variant and omits its parent id', async () => {
  render(
    <PlatePage
      {...props}
      plates={props.plates.map((plate) =>
        plate.templateFamily === army.templateFamily
          ? { ...plate, templateRole: null }
          : plate,
      )}
    />,
  )
  expect(screen.getByText('No template yet')).toBeTruthy()
  const add = screen.getByRole('button', {
    name: 'Add Standard Gold to family',
  }) as HTMLButtonElement
  expect(add.disabled).toBe(false)
  fireEvent.click(add)
  fireEvent.click(screen.getByRole('button', { name: 'Add to family' }))
  await waitFor(() =>
    expect(state.edit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'AK.standard_gold' }),
      { templateFamily: army.templateFamily, templateRole: 'variant' },
    ),
  )
  expect(state.edit.mock.calls[0][1]).not.toHaveProperty('variantOfPlateId')
})

test('family and role edits use the editable fields contract', async () => {
  render(<PlatePage {...props} />)
  change('Template family', 'new_family')
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Template family' }), {
    key: 'Enter',
  })
  await waitFor(() =>
    expect(state.edit).toHaveBeenLastCalledWith(expect.anything(), {
      templateFamily: 'new_family',
    }),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Variant' }))
  await waitFor(() =>
    expect(state.edit).toHaveBeenLastCalledWith(expect.anything(), {
      templateRole: 'variant',
    }),
  )
})

async function conflict() {
  state.remote = {
    ...army,
    revision: 'fresh',
    checks: {
      ...army.checks,
      description: { value: 'Their story', status: 'good' },
    },
  }
  state.edit.mockResolvedValueOnce({
    ok: false,
    error: 'stale_plate',
    batchId: 'current',
    currentRevision: 'fresh',
    current: {
      id: army.id,
      state: army.state,
      slug: army.slug,
      displayName: army.displayName,
      image: '',
      tags: army.tags,
      description: 'Their story',
    },
    draft: { description: 'My story' },
  } satisfies EditResult)
  render(<PlatePage {...props} />)
  saveDescription('My story')
  await screen.findByText('Someone changed this while you were editing.')
}

test('Keep saved compares both values and drops the local draft without another save', async () => {
  await conflict()
  expect(screen.getByText('Saved: Their story')).toBeTruthy()
  expect(screen.getByText('Proposed: My story')).toBeTruthy()
  fireEvent.blur(description())
  fireEvent.click(screen.getByRole('button', { name: 'Keep saved' }))
  await waitFor(() => expect(description().value).toBe('Their story'))
  expect(
    screen.queryByText('Someone changed this while you were editing.'),
  ).toBeNull()
  expect(state.edit).toHaveBeenCalledTimes(1)
})

test('Reapply mine retries against the saved revision shown', async () => {
  await conflict()
  fireEvent.blur(description())
  fireEvent.click(screen.getByRole('button', { name: 'Reapply mine' }))
  await waitFor(() => expect(state.edit).toHaveBeenCalledTimes(2))
  expect(state.edit).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: army.id }),
    { description: 'My story' },
    { batchId: 'current', baseRevision: 'fresh' },
  )
  expect(state.mutate).not.toHaveBeenCalled()
  await screen.findByText('Saved to your batch')
})

test('a remote overlay refresh preserves an unsaved description draft', () => {
  const view = render(<PlatePage {...props} />)
  change('Description', 'My unsaved story')
  state.remote = {
    ...army,
    checks: {
      ...army.checks,
      description: { value: 'Remote story', status: 'good' },
    },
  }
  state.refreshed = true
  view.rerender(<PlatePage {...props} />)
  expect(description().value).toBe('My unsaved story')
})

test.each([
  ['forbidden', "Only the batch's creator or an Owner can edit it."],
  ['superseded_revision', 'This batch has a newer revision.'],
  ['invalid_state', 'This batch is no longer open for editing.'],
  ['not_found', 'This plate or batch could not be found.'],
] as const)('%s appears inline', async (error, message) => {
  state.edit.mockResolvedValueOnce({ ok: false, error })
  render(<PlatePage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Set as Standard' }))
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain(message),
  )
})

test('navigation keeps state filters and parked actions are disabled', () => {
  render(<PlatePage {...props} />)
  expect(
    screen.getByRole('link', { name: 'Back to Alaska' }).getAttribute('href'),
  ).toBe('/states/AK?show=tags&q=army')
  expect(
    (
      screen.getByRole('button', {
        name: 'Replace or crop',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true)
})


test('selected Batch survives the way back and adjacent Plate navigation', () => {
  state.query = 'show=tags&q=army&batch=shared'
  const view = render(<PlatePage {...props} />)
  const links = Array.from(view.container.querySelectorAll('a')).map(link => link.getAttribute('href'))
  expect(links).toContain('/states/AK?show=tags&q=army&batch=shared')
  expect(links).toContain('/plates/AK.standard_gold?show=tags&q=army&batch=shared')
})

test('back link displays the jurisdiction code', () => {
  render(<PlatePage {...props} />)
  expect(screen.getByRole('link', { name: 'Back to Alaska' }).textContent).toBe('AK')
})

test('other plates order variants first and preserve order within groups', () => {
  const outside = props.plates.filter(plate => plate.templateFamily !== army.templateFamily)
  const ordered = [...outside.filter(plate => plate.templateRole !== 'template'), ...outside.filter(plate => plate.templateRole === 'template')]
  render(<PlatePage {...props} />)
  expect(screen.getAllByRole('button', { name: /^Add .+ to family$/ }).map(button => button.getAttribute('aria-label'))).toEqual(ordered.slice(0, 100).map(plate => 'Add ' + plate.displayName + ' to family'))
})

test('template confirmation cancellation does not save', () => {
  render(<PlatePage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add Standard Gold to family' }))
  expect(screen.getByRole('alertdialog').textContent).toBe('Add Standard Gold to this family?It stops being a Template.CancelAdd to family')
  expect(state.edit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(state.edit).not.toHaveBeenCalled()
})

test('variant adds immediately without confirmation', async () => {
  const variant = { ...props.plates.find(plate => plate.id === 'AK.standard_gold')!, templateRole: 'variant' as const }
  render(<PlatePage {...props} plates={[...props.plates.filter(plate => plate.id !== variant.id), variant]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add Standard Gold to family' }))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  await waitFor(() => expect(state.edit).toHaveBeenCalledTimes(1))
})

test.each([1, 2])('templates with %i linked variants cannot be added', count => {
  const candidate = props.plates.find(plate => plate.id === 'AK.standard_gold')!
  const children = [
    { ...candidate, id: 'AK.explicit', displayName: 'Explicit child', templateRole: 'variant' as const, templateFamily: 'different', variantOfPlateId: candidate.id },
    { ...candidate, id: 'AK.legacy', displayName: 'Legacy child', templateRole: 'variant' as const, variantOfPlateId: null },
    { ...candidate, id: 'AK.unrelated', displayName: 'Unrelated child', templateRole: 'variant' as const, variantOfPlateId: 'AK.other' },
  ]
  render(<PlatePage {...props} plates={[slimPlate(army), candidate, ...children.slice(0, count), children[2], { ...candidate, id: 'AK.other', displayName: 'Other template', templateFamily: 'other' }]} />)
  const add = screen.getByRole('button', { name: 'Add Standard Gold to family' }) as HTMLButtonElement
  expect(add.disabled).toBe(true)
  expect(document.getElementById(add.getAttribute('aria-describedby')!)?.textContent).toBe('Move or detach its ' + count + ' ' + (count === 1 ? 'Variant' : 'Variants') + ' first.')
  fireEvent.click(add)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(state.edit).not.toHaveBeenCalled()
})

test('delete requires confirmation and Cancel leaves the batch unchanged', async () => {
  render(<PlatePage {...props} plates={[]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete plate' }))
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  expect(screen.getByText('It is removed from the game at the next Publish. You can undo until then.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(state.edit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Delete plate' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(state.edit).toHaveBeenCalledWith(expect.objectContaining({ id: army.id }), { deleted: true }))
})

test('pending deletion remains visible and can be undone', async () => {
  state.remote = { ...army, deleted: true }
  state.refreshed = true
  render(<PlatePage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Undo delete' }))
  await waitFor(() => expect(state.edit).toHaveBeenCalledWith(expect.objectContaining({ id: army.id }), { deleted: false }))
})

test('Standard deletion is disabled with a visible reason from the draft overlay', () => {
  state.remote = { ...army, isStandard: true }
  state.refreshed = true
  render(<PlatePage {...props} />)
  expect((screen.getByRole('button', { name: 'Delete plate' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('Set another Standard plate first.')).toBeTruthy()
})

test.each(['moved', 'promoted', 'deleted'] as const)('Template deletion counts Variants after the draft overlay: %s', action => {
  const template = { ...props.plate, isStandard: false, templateRole: 'template' as const, templateFamily: 'test-family' }
  const variant = { ...army, id: 'AK.variant', templateRole: 'variant' as const, templateFamily: 'test-family', variantOfPlateId: template.id }
  render(<PlatePage {...props} plate={template} plates={[template, variant]} />)
  expect((screen.getByRole('button', { name: 'Delete plate' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('Move or promote its 1 Variants first.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Delete plate' }))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(state.edit).not.toHaveBeenCalled()
  cleanup()
  state.remote = action === 'moved' ? { ...variant, templateFamily: 'other', variantOfPlateId: null }
    : action === 'promoted' ? { ...variant, templateRole: 'template', variantOfPlateId: null } : { ...variant, deleted: true }
  state.refreshed = true
  render(<PlatePage {...props} plate={template} plates={[template, variant]} />)
  expect((screen.getByRole('button', { name: 'Delete plate' }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.queryByText('Move or promote its 1 Variants first.')).toBeNull()
})
