import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ResearchResult } from '../../components/research/research-result'
import { emptyResearchDraft } from '../../lib/research/types'

afterEach(cleanup)
const result = { draft: { ...emptyResearchDraft(), description: 'This plate supports habitat conservation throughout Arizona through optional registration fees.', descriptionSources: ['S1'], funFacts: [{ text: 'This program began supporting wildlife in 1987.', sourceId: 'S1' }], readMore: ['S1'] }, sources: [{ id: 'S1', kind: 'web' as const, title: 'Wildlife program', url: 'https://example.com/wildlife', text: 'Program evidence', fetchedAt: '2026-11-17', contentHash: 'hash' }], rejected: [], input: { plateId: 'AZ.one', state: 'AZ', displayName: 'Wildlife', inputRevision: 'r1', baselineVersion: 1 }, provenance: { executor: 'eve' as const, model: 'sol', codeRevision: 'c', promptVersion: 'p' }, attempts: [], durationMs: 1, status: 'ok' as const, cost: { usd: 0.02, missing: 0 }, counters: {}, cache: 'fresh' as const }

test('shows citations and sends only chosen fields with edited wording', () => {
  const accept = vi.fn()
  render(<ResearchResult result={result} pending={false} onAccept={accept} />)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Description' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Edit description' }), { target: { value: 'A revised description for this habitat conservation plate.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Accept selected fields' }))
  expect(accept).toHaveBeenCalledWith(['description'], expect.objectContaining({ description: 'A revised description for this habitat conservation plate.' }))
  expect(screen.getByRole('link', { name: 'S1 · Wildlife program' }).getAttribute('href')).toBe('https://example.com/wildlife')
})

test('missing fields cannot be selected and acceptance needs an explicit choice', () => {
  render(<ResearchResult result={{ ...result, draft: emptyResearchDraft() }} pending={false} onAccept={vi.fn()} />)
  expect((screen.getByRole('checkbox', { name: 'Description' }) as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Accept selected fields' }) as HTMLButtonElement).disabled).toBe(true)
})
