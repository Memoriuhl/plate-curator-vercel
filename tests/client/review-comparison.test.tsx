import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { DiffTable } from '../../components/review/diff'
import type { Plate } from '../../lib/catalog/types'

afterEach(cleanup)

test('comparison buttons switch the selected pane without losing either revision', () => {
  const before: Plate = {
    id: 'AK.standard', state: 'AK', slug: 'standard', image: '',
    displayName: 'Standard', description: 'Original description', tags: ['gold'],
  }
  render(<DiffTable before={before} after={{ ...before, description: 'Updated description' }} version={11} revision={4} order={[before.id]} />)
  const beforeButton = screen.getByRole('button', { name: 'Before' })
  const afterButton = screen.getByRole('button', { name: 'After' })
  expect(beforeButton.getAttribute('aria-pressed')).toBe('true')
  expect(afterButton.getAttribute('aria-pressed')).toBe('false')
  expect(document.getElementById(beforeButton.getAttribute('aria-controls')!)?.textContent).toContain('Original description')
  expect(document.getElementById(afterButton.getAttribute('aria-controls')!)?.textContent).toContain('Updated description')
  fireEvent.click(afterButton)
  expect(beforeButton.getAttribute('aria-pressed')).toBe('false')
  expect(afterButton.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(beforeButton)
  expect(beforeButton.getAttribute('aria-pressed')).toBe('true')
  expect(afterButton.getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByRole('heading', { name: 'Before · live v11' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'After · rev 4' })).toBeTruthy()
})
