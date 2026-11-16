import { isValidElement, type ReactNode, type ReactElement } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { plateCards } from '../fixtures/plate-cards'
import { PlatePage } from '../components/plate-page/plate-page'
import type { EditResult } from '../components/plate-page/edit-adapter'
import { slimPlate, type PlatePageProps } from '../components/plate-page/types'

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  edit: vi.fn(),
  pending: false,
}))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.cursor++
    if (!(index in state.values)) state.values[index] = initial
    return [
      state.values[index],
      (value: unknown) => {
        state.values[index] = value
      },
    ]
  },
}))
vi.mock('../components/plate-page/edit-adapter', () => ({
  useEditPlate: () => ({ edit: state.edit, pending: state.pending }),
  useDraftOverlay: (plates: unknown[]) => plates,
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('show=tags&q=army'),
  useRouter: () => ({ back: vi.fn() }),
}))
vi.mock('next/link', () => ({ default: (props: object) => <a {...props} /> }))
vi.mock('next/image', () => ({ default: () => <span /> }))
vi.mock('../components/ui/button', () => ({
  Button: (props: object) => <button {...props} />,
}))

type Node = { props: Record<string, unknown>; text: string }
let nodes: Node[] = []
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
  templateIndex: 2,
  templateCount: 3,
}

function walk(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(walk).join('')
  if (!isValidElement(node))
    return typeof node === 'string' || typeof node === 'number'
      ? String(node)
      : ''
  const element = node as ReactElement<Record<string, unknown>>
  if (typeof element.type === 'function')
    return walk((element.type as (props: object) => ReactNode)(element.props))
  const text = walk(element.props.children as ReactNode)
  nodes.push({ props: element.props, text })
  return text
}

function render(pageProps = props) {
  let text = ''
  for (let pass = 0; pass < 4; pass++) {
    const previous = [...state.values]
    nodes = []
    state.cursor = 0
    text = walk(<PlatePage {...pageProps} />)
    if (
      previous.length === state.values.length &&
      previous.every((value, index) => value === state.values[index])
    )
      break
  }
  return text
}

function byLabel(label: string) {
  return nodes.find((node) => node.props['aria-label'] === label)!
}

function button(text: string) {
  return nodes.find(
    (node) => node.text === text && typeof node.props.onClick === 'function',
  )!
}

async function click(node: Node) {
  await (node.props.onClick as () => Promise<void>)()
}

function change(label: string, value: string) {
  ;(byLabel(label).props.onChange as (event: object) => void)({
    target: { value },
  })
  render()
}

async function key(label: string, key: string, ctrlKey = false) {
  ;(byLabel(label).props.onKeyDown as (event: object) => void)({
    key,
    ctrlKey,
    preventDefault() {},
  })
  await Promise.resolve()
}

beforeEach(() => {
  state.values = []
  state.pending = false
  state.edit.mockReset().mockResolvedValue({ ok: true })
  render()
})

test('tags normalize on Enter, deduplicate, and remove individually', async () => {
  change('Add tag', '  NEW TAG  ')
  await key('Add tag', 'Enter')
  expect(state.edit).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: army.id }),
    { tags: [...army.tags, 'new tag'] },
  )
  change('Add tag', army.tags[0])
  await key('Add tag', 'Enter')
  expect(state.edit).toHaveBeenCalledTimes(1)
  await click(byLabel(`Remove tag ${army.tags[0]}`))
  expect(state.edit).toHaveBeenLastCalledWith(expect.anything(), {
    tags: army.tags.slice(1),
  })
})

test('description stays local until blur or Ctrl+Enter, empty sends null', async () => {
  change('Description', 'Updated story')
  expect(state.edit).not.toHaveBeenCalled()
  await key('Description', 'Enter', true)
  expect(state.edit).toHaveBeenLastCalledWith(expect.anything(), {
    description: 'Updated story',
  })
  change('Description', '')
  await (byLabel('Description').props.onBlur as () => void)()
  expect(state.edit).toHaveBeenLastCalledWith(expect.anything(), {
    description: null,
  })
})

test('overlong descriptions stay local and show a validation message', async () => {
  change('Description', 'x'.repeat(2001))
  await key('Description', 'Enter', true)
  expect(state.edit).not.toHaveBeenCalled()
  expect(render()).toContain('2000 characters or fewer')
})

test('Standard toggle sends the inverse value', async () => {
  await click(button('Set as Standard'))
  expect(state.edit).toHaveBeenCalledWith(expect.anything(), {
    isStandard: !army.isStandard,
  })
})

test('family plus sends the destination family and its template id', async () => {
  await click(byLabel('Add Standard Gold to family'))
  expect(state.edit).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'AK.standard_gold' }),
    {
      templateFamily: army.templateFamily,
      templateRole: 'variant',
      variantOfPlateId: army.id,
    },
  )
})

test('family without a template allows adding a variant and omits its parent id', async () => {
  const html = render({
    ...props,
    plates: props.plates.map((plate) =>
      plate.templateFamily === army.templateFamily
        ? { ...plate, templateRole: null }
        : plate,
    ),
  })
  expect(html).toContain('No template yet')
  const add = byLabel('Add Standard Gold to family')
  expect(add.props.disabled).toBe(false)
  await click(add)
  expect(state.edit).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'AK.standard_gold' }),
    { templateFamily: army.templateFamily, templateRole: 'variant' },
  )
  expect(state.edit.mock.calls[0][1]).not.toHaveProperty('variantOfPlateId')
})

test('family and role edits use the editable fields contract', async () => {
  change('Template family', 'new_family')
  await key('Template family', 'Enter')
  expect(state.edit).toHaveBeenLastCalledWith(expect.anything(), {
    templateFamily: 'new_family',
  })
  await click(button('Variant'))
  expect(state.edit).toHaveBeenLastCalledWith(expect.anything(), {
    templateRole: 'variant',
  })
})

async function conflict() {
  state.edit.mockResolvedValueOnce({
    ok: false,
    error: 'stale_plate',
    current: { ...army, description: 'Their story', revision: 'fresh' },
    draft: { description: 'My story' },
  } satisfies EditResult)
  change('Description', 'My story')
  await key('Description', 'Enter', true)
  await Promise.resolve()
  return render()
}

test('conflict compares both values and Keep theirs drops the local draft', async () => {
  expect(await conflict()).toContain(
    'Someone changed this while you were editing.',
  )
  expect(render()).toContain('Theirs: Their storyYours: My story')
  await click(button('Keep theirs'))
  expect(render()).not.toContain('Someone changed this')
  expect(byLabel('Description').props.value).toBe('Their story')
  expect(state.edit).toHaveBeenCalledTimes(1)
})

test('Use mine retries the draft against the fresh revision', async () => {
  await conflict()
  await click(button('Use mine'))
  expect(state.edit).toHaveBeenLastCalledWith(
    expect.objectContaining({ revision: 'fresh' }),
    { description: 'My story' },
  )
  expect(render()).toContain('Saved to your batch')
})

test.each([
  ['forbidden', "Only the batch's creator or an Owner can edit it."],
  ['superseded_revision', 'This batch has a newer revision.'],
  ['invalid_state', 'This batch is no longer open for editing.'],
  ['not_found', 'This plate or batch could not be found.'],
  ['unavailable', 'Editing is waiting for the draft service'],
] as const)('%s appears inline', async (error, message) => {
  state.edit.mockResolvedValueOnce({ ok: false, error })
  await click(button('Set as Standard'))
  expect(render()).toContain(message)
})

test('navigation retains state filters and parked actions are disabled', () => {
  expect(
    nodes.some((node) => node.props.href === '/states/AK?show=tags&q=army'),
  ).toBe(true)
  expect(button('Set as Standard').props.disabled).toBe(false)
  expect(
    nodes.find((node) => node.text === 'Replace or crop' && node.props.disabled)
      ?.props.disabled,
  ).toBe(true)
})
