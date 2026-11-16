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
  pending: false,
  remote: null as PlateCardData | null,
  refreshed: false,
}))
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
  useSearchParams: () => new URLSearchParams('show=tags&q=army'),
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

test('Keep theirs compares both values and drops the local draft without another save', async () => {
  await conflict()
  expect(screen.getByText('Theirs: Their story')).toBeTruthy()
  expect(screen.getByText('Yours: My story')).toBeTruthy()
  fireEvent.blur(description())
  fireEvent.click(screen.getByRole('button', { name: 'Keep theirs' }))
  await waitFor(() => expect(description().value).toBe('Their story'))
  expect(
    screen.queryByText('Someone changed this while you were editing.'),
  ).toBeNull()
  expect(state.edit).toHaveBeenCalledTimes(1)
})

test('Use mine refreshes the batch revision before retrying the draft', async () => {
  await conflict()
  fireEvent.blur(description())
  fireEvent.click(screen.getByRole('button', { name: 'Use mine' }))
  await waitFor(() => expect(state.edit).toHaveBeenCalledTimes(2))
  expect(state.edit).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: army.id }),
    { description: 'My story' },
  )
  expect(state.mutate).toHaveBeenCalledOnce()
  const matches = state.mutate.mock.calls[0][0]
  expect(matches('/api/batches/current')).toBe(true)
  expect(matches('/api/plates/AK.army')).toBe(false)
  expect(state.mutate.mock.invocationCallOrder[0]).toBeLessThan(
    state.edit.mock.invocationCallOrder[1],
  )
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
    screen.getByRole('link', { name: 'Alaska' }).getAttribute('href'),
  ).toBe('/states/AK?show=tags&q=army')
  expect(
    (
      screen.getByRole('button', {
        name: 'Replace or crop',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true)
})
