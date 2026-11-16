import { cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { FamilyCard } from '../components/plate/family-card'
import { useGridEntrance } from '../components/dashboard/use-grid-entrance'
import { plateCards } from '../fixtures/plate-cards'

const prefetch = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ prefetch }) }))
vi.mock('next/link', () => ({ default: ({ prefetch: ignored, ...props }: Record<string, unknown>) => { void ignored; return <a {...props} /> } }))
const animate = vi.fn()
let reduced = false
beforeEach(() => {
  prefetch.mockReset()
  animate.mockReset().mockImplementation(() => ({ cancel: vi.fn() }))
  vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  HTMLElement.prototype.animate = animate
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); reduced = false })

test('plate pointer intent and focus prefetch each plate once', () => {
  const view = render(<FamilyCard template={plateCards[0]} variants={[plateCards[1]]} />)
  const links = view.getAllByRole('link')
  fireEvent.pointerEnter(links[0])
  fireEvent.pointerEnter(links[0])
  fireEvent.focus(links[0])
  fireEvent.focus(links[1])
  expect(prefetch.mock.calls).toEqual([['/plates/' + plateCards[0].id], ['/plates/' + plateCards[1].id]])
})

test('information button hover anchors to the button, plate focus to its image', () => {
  const preview = vi.fn()
  const close = vi.fn()
  const view = render(<FamilyCard template={plateCards[0]} variants={[]} onPreview={preview} onClosePreview={close} />)
  const button = view.getByRole('button')
  fireEvent.mouseEnter(button)
  expect(preview).toHaveBeenLastCalledWith(plateCards[0], button, false)
  fireEvent.mouseLeave(button)
  expect(close).toHaveBeenCalledOnce()
  fireEvent.focus(view.getByRole('link'))
  expect(preview).toHaveBeenLastCalledWith(plateCards[0], view.container.querySelector('[data-plate-image]'), true)
})

function grid() {
  const container = document.createElement('div')
  container.innerHTML = '<div data-index="0"><article><div data-plate-image></div></article></div>'
  container.firstElementChild!.getBoundingClientRect = () => ({ top: 100, bottom: 300 }) as DOMRect
  container.querySelector('[data-plate-image]')!.getBoundingClientRect = () => ({ top: 100, bottom: 142, left: 20 }) as DOMRect
  document.body.append(container)
  return { current: container }
}

test('only first visible rows animate, later mounts and remounts never replay', () => {
  const container = grid()
  const view = renderHook(({ identity }) => useGridEntrance(container, true, identity), { initialProps: { identity: '/states/MD' } })
  expect(animate).toHaveBeenCalledTimes(2)
  container.current.innerHTML = '<div data-index="1"><article><div data-plate-image></div></article></div>'
  view.rerender({ identity: '/states/MD' })
  container.current.innerHTML = '<div data-index="0"><article><div data-plate-image></div></article></div>'
  view.rerender({ identity: '/states/MD' })
  expect(animate).toHaveBeenCalledTimes(2)
  container.current.firstElementChild!.getBoundingClientRect = () => ({ top: 100, bottom: 300 }) as DOMRect
  container.current.querySelector('[data-plate-image]')!.getBoundingClientRect = () => ({ top: 100, bottom: 142, left: 20 }) as DOMRect
  view.rerender({ identity: '/states/AK' })
  expect(animate).toHaveBeenCalledTimes(4)
  container.current.remove()
})

test('reduced motion leaves all cards immediately visible without animation', () => {
  reduced = true
  const container = grid()
  renderHook(() => useGridEntrance(container, true, '/states/MD'))
  expect(animate).not.toHaveBeenCalled()
  expect(container.current.querySelector('article')?.getAttribute('style')).toBeNull()
  container.current.remove()
})

test('only visible images animate in visual lines while containers stay still', () => {
  const container = grid()
  container.current.innerHTML = '<div><article><div data-plate-image></div><div data-plate-image></div></article><article><div data-plate-image></div><div data-plate-image></div><div data-plate-image></div></article></div>'
  const images = Array.from(container.current.querySelectorAll('[data-plate-image]'))
  const positions = [{ top: 100, left: 20 }, { top: 200, left: 20 }, { top: 108, left: 220 }, { top: 109, left: 420 }, { top: 1200, left: 220 }]
  images.forEach((image, index) => { image.getBoundingClientRect = () => ({ ...positions[index], bottom: positions[index].top + 42 }) as DOMRect })
  renderHook(() => useGridEntrance(container, true, '/states/AK'))
  expect(animate.mock.contexts).toEqual([images[0], images[0], images[2], images[2], images[3], images[3], images[1], images[1]])
  expect(animate.mock.calls.map(call => call[1].delay)).toEqual([0, 0, 30, 30, 55, 55, 110, 110])
  container.current.remove()
})
test('preview stays closed while its plate image is dropping', () => {
  const preview = vi.fn()
  const view = render(<FamilyCard template={plateCards[0]} variants={[]} onPreview={preview} />)
  const image = view.container.querySelector('[data-plate-image]')!
  image.getAnimations = () => [{ playState: 'running', pending: false }] as Animation[]
  fireEvent.mouseEnter(view.getByRole('button'))
  fireEvent.focus(view.getByRole('link'))
  expect(preview).not.toHaveBeenCalled()
})

test('shared intent registry prevents repeated prefetch after virtualized remount', () => {
  const ids = new Set<string>()
  const view = render(<FamilyCard template={plateCards[0]} variants={[]} prefetchedIds={ids} />)
  fireEvent.pointerEnter(view.getByRole('link'))
  view.unmount()
  const remounted = render(<FamilyCard template={plateCards[0]} variants={[]} prefetchedIds={ids} />)
  fireEvent.pointerEnter(remounted.getByRole('link'))
  expect(prefetch).toHaveBeenCalledOnce()
})

const previewDetail = vi.hoisted(() => ({ data: undefined as undefined | { plate: typeof plateCards[number] } }))
vi.mock('../lib/client/hooks', () => ({
  usePlateDetail: () => previewDetail,
  useDraftOverlay: (plates: unknown[]) => plates,
}))
import { ReadyPlatePreview, CheckValue } from '../components/plate/ready-plate-preview'
import { act } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'

function pendingPreview(checkKey?: import('../lib/catalog/dashboard-types').PlateCheckKey, immediate = false) {
  const anchor = document.createElement('span')
  document.body.append(anchor)
  const props = { plate: plateCards[0], anchor, checkKey, immediate }
  return { ...render(<ReadyPlatePreview {...props} />), props, anchor }
}

beforeEach(() => {
  previewDetail.data = undefined
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { vi.useRealTimers() })

test('breakdown requires both intent and cached detail', () => {
  vi.useFakeTimers()
  const view = pendingPreview()
  act(() => vi.advanceTimersByTime(150))
  expect(document.querySelector('[role=tooltip]')).toBeNull()
  previewDetail.data = { plate: plateCards[0] }
  view.rerender(<ReadyPlatePreview {...view.props} />)
  expect(document.querySelector('[role=tooltip]')).not.toBeNull()
  expect(document.querySelector('[aria-busy]')).toBeNull()
  view.anchor.remove()
})

test('warm breakdown waits 150 ms; focus has no intent delay', () => {
  vi.useFakeTimers()
  previewDetail.data = { plate: plateCards[0] }
  const view = pendingPreview()
  act(() => vi.advanceTimersByTime(149))
  expect(document.querySelector('[role=tooltip]')).toBeNull()
  act(() => vi.advanceTimersByTime(1))
  expect(document.querySelector('[role=tooltip]')).not.toBeNull()
  view.unmount()
  const focused = pendingPreview(undefined, true)
  expect(document.querySelector('[role=tooltip]')).not.toBeNull()
  focused.anchor.remove(); view.anchor.remove()
})

test('focus waits for detail and slow breakdown replaces its skeleton in one step', () => {
  vi.useFakeTimers()
  const view = pendingPreview(undefined, true)
  expect(document.querySelector('[role=tooltip]')).toBeNull()
  act(() => vi.advanceTimersByTime(1499))
  expect(document.querySelector('[role=tooltip]')).toBeNull()
  act(() => vi.advanceTimersByTime(1))
  expect(document.querySelector('[aria-busy=true]')).not.toBeNull()
  expect(document.body.textContent).not.toContain(plateCards[0].displayName)
  previewDetail.data = { plate: plateCards[0] }
  view.rerender(<ReadyPlatePreview {...view.props} />)
  expect(document.querySelector('[aria-busy]')).toBeNull()
  expect(document.body.textContent).toContain(plateCards[0].displayName)
  view.anchor.remove()
})

test('leaving early cancels pending preview and its timers', () => {
  vi.useFakeTimers()
  const view = pendingPreview()
  view.unmount()
  previewDetail.data = { plate: plateCards[0] }
  act(() => vi.advanceTimersByTime(2000))
  expect(document.querySelector('[role=tooltip]')).toBeNull()
  view.anchor.remove()
})

test('detail tooltip waits for cached data and keeps just one tooltip', () => {
  vi.useFakeTimers()
  const view = pendingPreview('description')
  act(() => vi.advanceTimersByTime(300))
  expect(document.querySelector('[data-check-tooltip]')).toBeNull()
  previewDetail.data = { plate: plateCards[0] }
  view.rerender(<ReadyPlatePreview {...view.props} />)
  expect(document.querySelectorAll('[data-check-tooltip]')).toHaveLength(1)
  expect(document.body.textContent).toContain(plateCards[0].checks.description.value)
  view.rerender(<ReadyPlatePreview {...view.props} checkKey="tags" />)
  act(() => vi.advanceTimersByTime(300))
  expect(document.querySelectorAll('[data-check-tooltip]')).toHaveLength(1)
  view.anchor.remove()
})

test('slow tooltip freezes Loading until the pointer leaves', () => {
  vi.useFakeTimers()
  const view = pendingPreview('description')
  act(() => vi.advanceTimersByTime(1500))
  expect(document.body.textContent).toContain('Loading…')
  previewDetail.data = { plate: plateCards[0] }
  view.rerender(<ReadyPlatePreview {...view.props} />)
  expect(document.body.textContent).toContain('Loading…')
  view.anchor.remove()
})

test.each(['description', 'funFacts', 'link', 'tags', 'family', 'image', 'rarity'] as const)('formats %s and missing values', checkKey => {
  const base = { ...plateCards[0], tags: ['Military'], templateFamily: 'Army', templateRole: 'variant' as const, imageUrl: '/plate.png', checks: { ...plateCards[0].checks, [checkKey]: { status: 'good' as const, value: checkKey === 'funFacts' ? 'First fact\nSecond fact' : 'Full value' } } }
  const html = renderToStaticMarkup(<CheckValue plate={base} checkKey={checkKey} parent="Army" />)
  expect(html).toContain(checkKey === 'tags' ? 'Military' : checkKey === 'family' ? 'Army · variant of Army' : checkKey === 'image' ? `${base.imageSize.width} px` : checkKey === 'funFacts' ? '2' : 'Full value')
  const empty = { ...base, tags: [], templateFamily: null, imageUrl: null, checks: { ...base.checks, [checkKey]: { status: 'missing' as const, value: null } } }
  expect(renderToStaticMarkup(<CheckValue plate={empty} checkKey={checkKey} />)).toContain(checkKey === 'tags' ? 'None' : 'Missing')
})

test('check strip suppresses breakdown while delegating unfocusable icon hover', () => {
  const preview = vi.fn(); const check = vi.fn(); const dismiss = vi.fn()
  const view = render(<FamilyCard template={plateCards[0]} variants={[]} onPreview={preview} onCheck={check} onDismissPreview={dismiss} />)
  const icon = view.container.querySelector<HTMLElement>('[data-check]')!
  fireEvent.pointerOver(icon)
  fireEvent.mouseOver(icon)
  expect(preview).not.toHaveBeenCalled()
  expect(check).toHaveBeenCalledWith(plateCards[0], 'description', icon)
  expect(dismiss).toHaveBeenCalledOnce()
  expect(icon.tabIndex).toBe(-1)
})

test('only image and information hover open breakdown; text, id and container do not', () => {
  const preview = vi.fn()
  const view = render(<FamilyCard template={plateCards[0]} variants={[]} onPreview={preview} />)
  for (const element of [view.getByRole('article'), view.getByRole('link'), view.getByRole('heading'), view.container.querySelector('.id')!]) {
    fireEvent.mouseOver(element)
    fireEvent.mouseEnter(element)
  }
  expect(preview).not.toHaveBeenCalled()
  const image = view.container.querySelector<HTMLElement>('[data-plate-image]')!
  fireEvent.mouseEnter(image)
  expect(preview).toHaveBeenLastCalledWith(plateCards[0], image, false)
  fireEvent.focus(view.getByRole('link'))
  expect(preview).toHaveBeenLastCalledWith(plateCards[0], image, true)
  const info = view.getByRole('button', { name: 'Preview ' + plateCards[0].displayName })
  fireEvent.mouseEnter(info)
  expect(preview).toHaveBeenLastCalledWith(plateCards[0], info, false)
})
