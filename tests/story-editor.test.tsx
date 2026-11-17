// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { StoryEditor } from '../components/plate-page/story-editor'
import { plateCards } from '../fixtures/plate-cards'

afterEach(() => { cleanup(); vi.unstubAllEnvs() })

test('requires a citation before a fact can be saved to the captured plate revision', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const save = vi.fn().mockResolvedValue(true)
  const plate = { ...plateCards[0], firstIssuedYear: 1976 }
  render(<StoryEditor plate={plate} pending={false} save={save} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add fact' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Fact 1 text' }), { target: { value: 'A sourced fact.' } })
  expect(screen.getByRole('button', { name: 'Save story to Batch' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: 'Fact 1 sourceUrl' }), { target: { value: 'https://example.org/fact' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save story to Batch' }))
  await waitFor(() => expect(save).toHaveBeenCalledWith(plate, { funFacts: [{ text: 'A sourced fact.', sourceUrl: 'https://example.org/fact' }] }))
  expect(screen.getByRole('status').textContent).toContain('Story saved')
})

test('adds and removes read-more links and clears optional fields', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const save = vi.fn().mockResolvedValue(true)
  render(<StoryEditor plate={{ ...plateCards[0], firstIssuedYear: 1976, sourceUrl: 'https://example.org/source' }} pending={false} save={save} />)
  fireEvent.change(screen.getByRole('spinbutton', { name: 'First issued year' }), { target: { value: '' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Source URL' }), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add link' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Link 1 title' }), { target: { value: 'Reference' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Link 1 url' }), { target: { value: 'https://example.org/reference' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save story to Batch' }))
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ firstIssuedYear: null, sourceUrl: null, readMore: [{ title: 'Reference', site: '', url: 'https://example.org/reference' }] })))
  fireEvent.click(screen.getByRole('button', { name: 'Remove link 1' }))
  expect(screen.queryByRole('textbox', { name: 'Link 1 url' })).toBeNull()
})

test('a failed save retains the entered draft for retry', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const save = vi.fn().mockResolvedValue(false)
  render(<StoryEditor plate={plateCards[0]} pending={false} save={save} />)
  fireEvent.change(screen.getByRole('spinbutton', { name: 'First issued year' }), { target: { value: '1980' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save story to Batch' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect((screen.getByRole('spinbutton', { name: 'First issued year' }) as HTMLInputElement).value).toBe('1980')
  expect(screen.queryByRole('status')).toBeNull()
})

test('saving an unchanged story produces no request or edit', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const save = vi.fn()
  render(<StoryEditor plate={plateCards[0]} pending={false} save={save} />)
  const button = screen.getByRole('button', { name: 'Save story to Batch' })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(button)
  fireEvent.submit(button.closest('form')!)
  expect(save).not.toHaveBeenCalled()
})
