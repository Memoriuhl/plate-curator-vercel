import { expect, test } from 'vitest'
import { catalogSourceKind } from '../../lib/catalog/source-kind'

test('uses Firestore unless the fixture source is requested', () => {
  expect(catalogSourceKind({})).toBe('firestore')
  expect(catalogSourceKind({ CATALOG_SOURCE: 'firestore', VERCEL_ENV: 'production' })).toBe('firestore')
})

test('allows the fixture source locally and in development', () => {
  expect(catalogSourceKind({ CATALOG_SOURCE: 'fixture' })).toBe('fixture')
  expect(catalogSourceKind({ CATALOG_SOURCE: 'fixture', VERCEL_ENV: 'development' })).toBe('fixture')
})

test('refuses the fixture source on preview and production', () => {
  expect(() => catalogSourceKind({ CATALOG_SOURCE: 'fixture', VERCEL_ENV: 'preview' })).toThrow(/refused/)
  expect(() => catalogSourceKind({ CATALOG_SOURCE: 'fixture', VERCEL_ENV: 'production' })).toThrow(/refused/)
})

test('rejects unknown source names', () => {
  expect(() => catalogSourceKind({ CATALOG_SOURCE: 'json' })).toThrow(/CATALOG_SOURCE/)
})
