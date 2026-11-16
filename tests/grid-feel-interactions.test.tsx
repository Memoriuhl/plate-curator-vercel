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
  container.innerHTML = '<div data-index="0"><article></article></div>'
  container.firstElementChild!.getBoundingClientRect = () => ({ top: 100, bottom: 300 }) as DOMRect
  document.body.append(container)
  return { current: container }
}

test('only first visible rows animate, later mounts and remounts never replay', () => {
  const container = grid()
  const view = renderHook(({ identity }) => useGridEntrance(container, true, identity), { initialProps: { identity: '/states/MD' } })
  expect(animate).toHaveBeenCalledTimes(2)
  container.current.innerHTML = '<div data-index="1"><article></article></div>'
  view.rerender({ identity: '/states/MD' })
  container.current.innerHTML = '<div data-index="0"><article></article></div>'
  view.rerender({ identity: '/states/MD' })
  expect(animate).toHaveBeenCalledTimes(2)
  container.current.firstElementChild!.getBoundingClientRect = () => ({ top: 100, bottom: 300 }) as DOMRect
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
test('preview stays closed while the family is dropping', () => {
  const preview = vi.fn()
  const view = render(<FamilyCard template={plateCards[0]} variants={[]} onPreview={preview} />)
  const card = view.getByRole('article')
  card.getAnimations = () => [{ playState: 'running', pending: false }] as Animation[]
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
