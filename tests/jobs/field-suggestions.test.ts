import { afterEach, expect, test, vi } from 'vitest'
import { parseFieldSuggestion } from '../../lib/jobs/suggestions'

afterEach(() => vi.unstubAllEnvs())
const suggestion = { kind: 'fields' as const, stage: 'story', fields: { funFacts: [{ text: 'A sourced fact', sourceUrl: 'https://example.org/fact' }], firstIssuedYear: 1976 }, sources: ['https://example.org/fact'] }

test('field suggestions require the local flag and the requested stage', () => {
  expect(parseFieldSuggestion(suggestion, 'story')).toBeNull()
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  expect(parseFieldSuggestion(suggestion, 'story')).toEqual(suggestion)
  expect(parseFieldSuggestion(suggestion, 'describe')).toBeNull()
})

test.each([
  { ...suggestion, fields: { firstIssuedYear: 1976 } },
  { ...suggestion, fields: { firstIssuedYear: 1976, funFacts: [] } },
  { ...suggestion, kind: undefined },
  { ...suggestion, kind: 'group' },
  { ...suggestion, sources: [] },
  { ...suggestion, sources: ['javascript:alert(1)'] },
  { ...suggestion, fields: { funFacts: [{ text: 'Uncited', sourceUrl: 'https://other.example/fact' }] } },
  { ...suggestion, fields: { deleted: true } },
  { ...suggestion, fields: { tags: ['bear'] } },
  { ...suggestion, fields: { sourceUrl: 'https://example.org/fact' } },
  { ...suggestion, fields: {} },
  { ...suggestion, extra: 'unrecognized' },
])('rejects malformed or unrelated fields and citations %j', input => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  expect(parseFieldSuggestion(input, 'story')).toBeNull()
})

test('Group stays unavailable until its multi-plate contract exists', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  expect(parseFieldSuggestion({ kind: 'fields', stage: 'group', fields: { templateFamily: 'one' }, sources: [] }, 'group')).toBeNull()
})

test.each(['describe', 'story', 'wiki-link', 'colors', 'find-image', 'group', 'order'] as const)('%s cannot overwrite image provenance', stage => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  expect(parseFieldSuggestion({ kind: 'fields', stage, fields: { sourceUrl: 'https://example.org/image' }, sources: ['https://example.org/image'] }, stage)).toBeNull()
})

test('canonicalizes object keys and source order for idempotent reports', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const input = { kind: 'fields' as const, stage: 'describe', fields: { description: ' Description ' }, sources: ['https://example.org/b', 'https://example.org/a', 'https://example.org/b'] }
  expect(parseFieldSuggestion(input, 'describe')).toEqual({ kind: 'fields' as const, stage: 'describe', fields: { description: 'Description' }, sources: ['https://example.org/a', 'https://example.org/b'] })
})
