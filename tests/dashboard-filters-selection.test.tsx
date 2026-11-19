// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { FilterBarControls } from '../components/dashboard/filter-bar'
import { TooltipProvider } from '../components/ui/tooltip'
import {
  filterCounts,
  matchesPlate,
  parseShow,
  serializeShow,
} from '../components/dashboard/family-data'
import {
  plateSelection,
  useSelectionKeyboard,
} from '../components/dashboard/plate-selection'
import { SelectionBar } from '../components/dashboard/selection-bar'
import { selectionActions } from '../components/dashboard/selection-actions'
import {
  disabledRunStages,
  newRunStages,
  pipelineStages,
  stageAvailability,
} from '../components/dashboard/pipeline-stages'
import { alaskaFixture } from '../fixtures/dashboard-frame'
import type { PlateCardData } from '../lib/catalog/dashboard-types'

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  query: '',
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigation.query),
  usePathname: () => '/states/AK',
  useRouter: () => navigation,
}))

beforeEach(() => {
  navigation.query = ''
})
afterEach(() => {
  cleanup()
  plateSelection.clear()
  vi.clearAllMocks()
})

/** Build plates that differ only in the checks the filters read. */
function plateWith(
  id: string,
  missing: { image?: boolean; funFacts?: boolean; description?: boolean }
): PlateCardData {
  const base = structuredClone(alaskaFixture.plates[0])
  base.id = id
  base.displayName = id
  base.tags = ['gold', 'a', 'b', 'c', 'd']
  for (const key of ['image', 'funFacts', 'description'] as const)
    base.checks[key].status = 'good'
  base.checks.tags.status = 'good'
  base.templateRole = 'template'
  if (missing.image) base.checks.image.status = 'missing'
  if (missing.funFacts) base.checks.funFacts.status = 'missing'
  if (missing.description) base.checks.description.status = 'missing'
  return base
}
const plates = [
  plateWith('AK.both', { image: true, funFacts: true }),
  plateWith('AK.image', { image: true }),
  plateWith('AK.facts', { funFacts: true }),
  plateWith('AK.fine', {}),
]
const none = new Set<string>()
/** IDs of the plates a filter combination keeps. */
const kept = (show: string, query = '') =>
  plates
    .filter((plate) => matchesPlate(plate, show, query, none))
    .map((plate) => plate.id)

test('several filters combine with AND, and search narrows further', () => {
  expect(kept('all')).toHaveLength(4)
  expect(kept('missingImage')).toEqual(['AK.both', 'AK.image'])
  expect(kept('missingImage,nofunfacts')).toEqual(['AK.both'])
  expect(kept('nofunfacts,missingImage')).toEqual(['AK.both'])
  expect(kept('missingImage,nofunfacts', 'nothing like it')).toEqual([])
  expect(kept('missingImage', 'AK.image')).toEqual(['AK.image'])
})

test('the show value parses and serializes as a comma list', () => {
  expect(parseShow(null)).toEqual([])
  expect(parseShow('all')).toEqual([])
  expect(parseShow('missingImage,bogus,missingImage,nofunfacts')).toEqual([
    'missingImage',
    'nofunfacts',
  ])
  expect(serializeShow([])).toBe('all')
  expect(serializeShow(['missingImage', 'nofunfacts'])).toBe(
    'missingImage,nofunfacts'
  )
})

/** Render the filter chips with the current mocked URL. */
function renderChips() {
  return render(
    <TooltipProvider>
      <FilterBarControls counts={filterCounts(plates)} changedCount={2} />
    </TooltipProvider>
  )
}

test('clicking a second chip adds it to the URL and clicking it again removes it', () => {
  navigation.query = 'q=gold&show=missingImage'
  renderChips()
  fireEvent.click(screen.getByRole('button', { name: /No fun facts/ }))
  expect(navigation.replace).toHaveBeenLastCalledWith(
    '/states/AK?q=gold&show=missingImage%2Cnofunfacts',
    { scroll: false }
  )
  fireEvent.click(screen.getByRole('button', { name: /No image/ }))
  expect(navigation.replace).toHaveBeenLastCalledWith(
    '/states/AK?q=gold&show=all',
    { scroll: false }
  )
})

test('every active chip is pressed, All plates is pressed only with none, and All clears', () => {
  navigation.query = 'show=missingImage,nofunfacts'
  renderChips()
  const pressed = (name: RegExp) =>
    screen.getByRole('button', { name }).getAttribute('aria-pressed')
  expect(pressed(/No image/)).toBe('true')
  expect(pressed(/No fun facts/)).toBe('true')
  expect(pressed(/All plates/)).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: /All plates/ }))
  expect(navigation.replace).toHaveBeenLastCalledWith('/states/AK?show=all', {
    scroll: false,
  })
})

test('the batch chip reads Unpublished changes', () => {
  renderChips()
  expect(
    screen.getByRole('button', { name: /Unpublished changes/ })
  ).toBeTruthy()
  expect(screen.queryByText(/Changed in a batch/)).toBeNull()
})

test('Shift-click on a chip still adds its group to the selection', () => {
  const onSelectGroup = vi.fn()
  render(
    <TooltipProvider>
      <FilterBarControls
        counts={filterCounts(plates)}
        changedCount={0}
        resolveGroup={() => ['AK.both']}
        onSelectGroup={onSelectGroup}
      />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: /No image/ }), {
    shiftKey: true,
  })
  expect(onSelectGroup).toHaveBeenCalledWith('missingImage', ['AK.both'])
  expect(navigation.replace).not.toHaveBeenCalled()
})

/** Mount the workspace keyboard shortcuts. */
function Keyboard() {
  useSelectionKeyboard({
    close() {},
    promote: async () => {},
    disabled: false,
  })
  return null
}

test('Cmd+A selects exactly the filtered set', () => {
  render(<Keyboard />)
  const filtered = plates.filter((plate) =>
    matchesPlate(plate, 'missingImage,nofunfacts', '', none)
  )
  act(() => plateSelection.visible(filtered))
  fireEvent.keyDown(window, { key: 'a', metaKey: true })
  expect(plateSelection.snapshot().map((plate) => plate.id)).toEqual([
    'AK.both',
  ])
  act(() => plateSelection.visible(plates))
  fireEvent.keyDown(window, { key: 'a', ctrlKey: true })
  expect(plateSelection.snapshot()).toHaveLength(4)
})

test('the selection bar runs the pipeline, makes Templates and clears', () => {
  const run = vi.fn()
  const promote = vi.fn()
  const unregister = [
    selectionActions.register('runPipeline', { run, disabled: false }),
    selectionActions.register('promote', { run: promote, disabled: false }),
  ]
  act(() => plateSelection.visible(plates))
  act(() => plateSelection.replace(plates.slice(0, 2)))
  render(<SelectionBar />)
  fireEvent.click(
    screen.getByRole('button', { name: 'Run pipeline on 2 plates' })
  )
  expect(run).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Make Templates' }))
  expect(promote).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  expect(plateSelection.snapshot()).toEqual([])
  unregister.forEach((fn) => fn())
})

test('the selection bar disables an action its owner has disabled and hides one with no owner', () => {
  const unregister = selectionActions.register('promote', {
    run: vi.fn(),
    disabled: true,
  })
  act(() => plateSelection.replace(plates.slice(0, 1)))
  render(<SelectionBar />)
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Make Templates' })
      .disabled
  ).toBe(true)
  expect(screen.queryByRole('button', { name: /Run pipeline on/ })).toBeNull()
  unregister()
})

test('Find image and Group are work in progress in every availability path', () => {
  const reasons = {
    'find-image':
      'Work in progress: candidates will wait for your pick in Review',
    group: 'Work in progress: proposed families will need your approval',
  }
  for (const [id, reason] of Object.entries(reasons)) {
    const stage = pipelineStages.find((stage) => stage.id === id)!
    expect(stage.localEnabled).toBe(false)
    expect(stage.disabledReason).toBe(reason)
    expect(stageAvailability(stage, true)).toBe(reason)
    expect(
      stageAvailability(stage, true, {
        group: { available: true },
        embeddings: { available: true },
        'find-image': { available: true },
      } as never)
    ).toBe(reason)
  }
  expect(disabledRunStages(['tag', 'group'])).toEqual(['group'])
  expect(disabledRunStages(['find-image', 'research', 'group'])).toEqual([
    'find-image',
    'group',
  ])
  expect(disabledRunStages(['tag', 'research', 'enhance-image'])).toEqual([])
})

test('each stage states how its result reaches the plate', () => {
  const rule = (id: string) =>
    pipelineStages.find((stage) => stage.id === id)?.resultRule
  expect(rule('tag')).toEqual({
    mode: 'automatic',
    label: 'Saved automatically; Review is optional',
  })
  expect(rule('research')?.mode).toBe('automatic')
  expect(rule('colors')?.mode).toBe('automatic')
  expect(rule('enhance-image')).toEqual({
    mode: 'apply',
    label: 'Waits until you click Apply',
  })
  expect(rule('find-image')?.mode).toBe('choose')
  expect(rule('group')?.mode).toBe('verify')
  expect(rule('order')).toBeUndefined()
  expect(newRunStages.every((stage) => stage.resultRule?.label.length)).toBe(
    true
  )
})
