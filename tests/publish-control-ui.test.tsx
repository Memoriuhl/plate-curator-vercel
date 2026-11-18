import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { PublishControlView } from '../components/publish/control'

afterEach(cleanup)
const control = {
  paused: true,
  generation: 2,
  changedBy: { uid: 'owner', email: 'owner@example.com' },
  changedAt: '2026-11-16T12:00:00Z',
}

test('Owner sees status, actor and time and explicitly resumes or pauses', async () => {
  const change = vi.fn(async () => {})
  const view = render(<PublishControlView control={control} change={change} />)
  expect(screen.getByText('Catalog publishing is paused.')).toBeTruthy()
  expect(screen.getByText(/owner@example.com/)).toBeTruthy()
  expect(view.container.querySelector('time')?.dateTime).toBe(control.changedAt)
  fireEvent.click(screen.getByRole('button', { name: 'Resume publishing' }))
  await waitFor(() => expect(change).toHaveBeenCalledWith(false))
  view.rerender(
    <PublishControlView
      control={{ ...control, paused: false }}
      change={change}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Pause publishing' }))
  await waitFor(() => expect(change).toHaveBeenCalledWith(true))
})

test('missing control offers first Resume; unavailable control disables changes', () => {
  const change = vi.fn()
  const view = render(<PublishControlView control={null} change={change} />)
  expect(
    screen.getByText('Catalog publishing is not enabled yet.')
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Resume publishing' })).toBeTruthy()
  view.rerender(<PublishControlView control={null} error change={change} />)
  expect(screen.getByRole('alert').textContent).toContain('unavailable')
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
})

test('a disabled deployment shows the persisted pause without offering Resume', () => {
  const change = vi.fn()
  render(
    <PublishControlView control={control} enabledHere={false} change={change} />
  )
  expect(screen.getByText('Catalog publishing is paused.')).toBeTruthy()
  expect(screen.getByText(/publishing-enabled deployment/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Resume publishing' })).toBeNull()
})
