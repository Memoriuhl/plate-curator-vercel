import { afterEach, expect, test, vi } from 'vitest'
import { firebaseHealth } from '../lib/health/firebase-health'

afterEach(() => {
  vi.restoreAllMocks()
})

test('reports the catalog version and is never cached', async () => {
  const response = await firebaseHealth(async () => 11)

  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ catalogVersion: 11 })
})

test('answers 503 with only an error code when Firestore fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const response = await firebaseHealth(async () => {
    throw new Error('PERMISSION_DENIED on projects/some-project')
  })

  expect(response.status).toBe(503)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ error: 'firebase_unavailable' })
})
