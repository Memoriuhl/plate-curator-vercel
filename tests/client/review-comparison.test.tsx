import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { DiffTable } from '../../components/review/diff'
import type { Plate } from '../../lib/catalog/types'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

test('comparison displays sourced facts, first-issued year and read-more values with editing disabled', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  const before: Plate = {
    id: 'AK.one',
    state: 'AK',
    slug: 'one',
    image: '',
    displayName: 'One',
    tags: [],
  }
  const after = {
    ...before,
    firstIssuedYear: 1976,
    funFacts: [{ text: 'Sourced fact', sourceUrl: 'https://example.org/fact' }],
    readMore: [
      {
        title: 'Reference',
        site: 'Example',
        url: 'https://example.org/reference',
      },
    ],
  }
  render(
    <DiffTable
      before={before}
      after={after}
      version={1}
      revision={2}
      order={[before.id]}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'After' }))
  const pane = document.getElementById(
    screen.getByRole('button', { name: 'After' }).getAttribute('aria-controls')!
  )!
  expect(pane.textContent).toContain('1976')
  expect(pane.textContent).toContain('Sourced fact')
  expect(pane.textContent).toContain('https://example.org/fact')
  expect(pane.textContent).toContain('https://example.org/reference')
  expect(pane.textContent).not.toContain('[object Object]')
})

test('comparison buttons switch the selected pane without losing either revision', () => {
  const before: Plate = {
    id: 'AK.standard',
    state: 'AK',
    slug: 'standard',
    image: '',
    displayName: 'Standard',
    description: 'Original description',
    tags: ['gold'],
  }
  render(
    <DiffTable
      before={before}
      after={{ ...before, description: 'Updated description' }}
      version={11}
      revision={4}
      order={[before.id]}
    />
  )
  const beforeButton = screen.getByRole('button', { name: 'Before' })
  const afterButton = screen.getByRole('button', { name: 'After' })
  expect(beforeButton.getAttribute('aria-pressed')).toBe('true')
  expect(afterButton.getAttribute('aria-pressed')).toBe('false')
  expect(
    document.getElementById(beforeButton.getAttribute('aria-controls')!)
      ?.textContent
  ).toContain('Original description')
  expect(
    document.getElementById(afterButton.getAttribute('aria-controls')!)
      ?.textContent
  ).toContain('Updated description')
  fireEvent.click(afterButton)
  expect(beforeButton.getAttribute('aria-pressed')).toBe('false')
  expect(afterButton.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(beforeButton)
  expect(beforeButton.getAttribute('aria-pressed')).toBe('true')
  expect(afterButton.getAttribute('aria-pressed')).toBe('false')
  expect(
    screen.getByRole('heading', { name: 'Before · Catalog v11' })
  ).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'After · rev 4' })).toBeTruthy()
})

test('each changed grouping field and the source link can be removed independently', () => {
  const before: Plate = {
    id: 'AK.one',
    state: 'AK',
    slug: 'one',
    image: '',
    displayName: 'One',
    tags: [],
    templateFamily: 'old',
    templateRole: 'template',
  }
  const after: Plate = {
    ...before,
    templateFamily: 'new',
    templateRole: 'variant',
    variantOfPlateId: 'AK.two',
    imageUrl: 'https://example.com/image.jpg',
    sourceUrl: 'https://example.com/source',
  }
  const discard = vi.fn()
  render(
    <DiffTable
      before={before}
      after={after}
      version={1}
      revision={2}
      order={[]}
      onDiscard={discard}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'After' }))
  fireEvent.click(
    screen.getByRole('button', { name: 'Remove family role change' })
  )
  fireEvent.click(
    screen.getByRole('button', { name: 'Remove source link change' })
  )
  expect(discard.mock.calls).toEqual([['templateRole'], ['sourceUrl']])
})

test('draft comparison allows reverting the one eligible pipeline field', () => {
  const before: Plate = {
    id: 'AK.one',
    state: 'AK',
    slug: 'one',
    image: '',
    displayName: 'One',
    tags: ['published'],
  }
  const after = {
    ...before,
    tags: ['draft'],
    description: 'Manual description',
  }
  const revert = vi.fn()
  render(
    <DiffTable
      before={before}
      after={after}
      version={1}
      revision={2}
      order={[before.id]}
      pipelineChanges={{
        tags: {
          runId: 'run',
          jobId: 'tag-job',
          by: 'editor',
          byName: 'Ro',
          at: '',
          value: after.tags,
          previous: ['earlier'],
        },
      }}
      onRevert={revert}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'After' }))
  fireEvent.click(screen.getByRole('button', { name: 'Revert tags' }))
  expect(revert).toHaveBeenCalledWith('tags', 'tag-job')
  expect(
    screen.queryByRole('button', { name: 'Revert description' })
  ).toBeNull()
})

test('the review comparison offers removal for individual manual fields and order', () => {
  const before: Plate = {
    id: 'AK.one',
    state: 'AK',
    slug: 'one',
    image: '',
    displayName: 'One',
    tags: ['published'],
  }
  const discard = vi.fn()
  render(
    <DiffTable
      compact
      before={before}
      after={{ ...before, tags: ['draft'], description: 'Edited description' }}
      version={4}
      revision={7}
      order={[]}
      positions={{ before: 2, after: 1, total: 3 }}
      onDiscard={discard}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'After' }))
  fireEvent.click(
    screen.getByRole('button', { name: 'Remove description change' })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Remove tags change' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove order change' }))
  expect(discard.mock.calls).toEqual([['description'], ['tags'], ['order']])
})
