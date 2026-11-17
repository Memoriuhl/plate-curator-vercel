import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { DiffTable } from '../../components/review/diff'
import type { Plate } from '../../lib/catalog/types'

afterEach(() => { cleanup(); vi.unstubAllEnvs() })

test('local comparison displays sourced facts, first-issued year and read-more values', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const before: Plate = { id: 'AK.one', state: 'AK', slug: 'one', image: '', displayName: 'One', tags: [] }
  const after = { ...before, firstIssuedYear: 1976, funFacts: [{ text: 'Sourced fact', sourceUrl: 'https://example.org/fact' }], readMore: [{ title: 'Reference', site: 'Example', url: 'https://example.org/reference' }] }
  render(<DiffTable before={before} after={after} version={1} revision={2} order={[before.id]} />)
  fireEvent.click(screen.getByRole('button', { name: 'After' }))
  const pane = document.getElementById(screen.getByRole('button', { name: 'After' }).getAttribute('aria-controls')!)!
  expect(pane.textContent).toContain('1976')
  expect(pane.textContent).toContain('Sourced fact')
  expect(pane.textContent).toContain('https://example.org/fact')
  expect(pane.textContent).toContain('https://example.org/reference')
  expect(pane.textContent).not.toContain('[object Object]')
})

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
  expect(screen.getByRole('heading', { name: 'Before · Catalog v11' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'After · rev 4' })).toBeTruthy()
})
