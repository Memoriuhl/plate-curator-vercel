import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LaunchSplash } from '@/components/app/launch-splash'
import { launchContentPending, launchReady } from '@/lib/launch/launch-ready'
import {
  BOOT_WAIT_CAP_MS,
  REDUCED_FADE_MS,
  REDUCED_HOLD_MS,
  minimumSplashMs,
  revealMs,
} from '@/lib/launch/splash-timeline'

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
    ],
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

test('the dashboard still loading keeps the splash up: access check or skeleton', () => {
  document.body.innerHTML =
    '<main class="session-loading">Checking access...</main>'
  expect(launchContentPending(document)).toBe(true)
  document.body.innerHTML =
    '<div class="dashboard-skeleton" role="status"></div>'
  expect(launchContentPending(document)).toBe(true)
  document.body.innerHTML = '<main class="app-main">Alaska</main>'
  expect(launchContentPending(document)).toBe(false)
})

test('ready once signed in, past the home redirect and nothing pending, or at the cap', () => {
  const settled = {
    sessionReady: true,
    pathname: '/states/AK',
    pending: false,
    elapsedMs: 0,
  }
  expect(launchReady(settled)).toBe(true)
  expect(launchReady({ ...settled, sessionReady: false })).toBe(false)
  expect(launchReady({ ...settled, pathname: '/' })).toBe(false)
  expect(launchReady({ ...settled, pending: true })).toBe(false)
  expect(
    launchReady({
      sessionReady: false,
      pathname: '/',
      pending: true,
      elapsedMs: BOOT_WAIT_CAP_MS,
    })
  ).toBe(true)
})

test('the splash covers the app from the first render', () => {
  render(<LaunchSplash ready={false} variant="still" />)
  expect(
    screen.getByRole('img', { name: 'A license plate gets spotted' })
  ).toBeTruthy()
})

test('a ready app pops, reveals and removes the splash', () => {
  const onDone = vi.fn()
  render(<LaunchSplash ready variant="still" onDone={onDone} />)
  act(() => {
    vi.advanceTimersByTime(minimumSplashMs('still') + revealMs('still') + 50)
  })
  expect(onDone).toHaveBeenCalledOnce()
  expect(
    screen.queryByRole('img', { name: 'A license plate gets spotted' })
  ).toBeNull()
})

test('a booting app holds the splash until it is ready, then pops', () => {
  const onDone = vi.fn()
  const { rerender } = render(
    <LaunchSplash ready={false} variant="reduced" onDone={onDone} />
  )
  act(() => {
    vi.advanceTimersByTime(5000)
  })
  expect(onDone).not.toHaveBeenCalled()
  rerender(<LaunchSplash ready variant="reduced" onDone={onDone} />)
  act(() => {
    vi.advanceTimersByTime(REDUCED_HOLD_MS + REDUCED_FADE_MS + 50)
  })
  expect(onDone).toHaveBeenCalledOnce()
})
