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
