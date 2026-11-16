import { expect, test } from 'vitest'
import { rejectWithoutSpikeSecret } from '../lib/spike/auth'

const secret = 'correct-horse-battery-staple'

function requestWith(header?: string) {
  const headers = header === undefined ? undefined : { 'x-spike-secret': header }
  return new Request('http://localhost/api/spike/start', { method: 'POST', headers })
}

test('lets a request with the right secret through', () => {
  expect(rejectWithoutSpikeSecret(requestWith(secret), secret)).toBeNull()
})

test.each([
  ['no header', requestWith(), secret],
  ['the wrong secret', requestWith('nope'), secret],
  ['no secret configured', requestWith(secret), undefined],
])('answers 401 with %s', async (_label, request, configured) => {
  const response = rejectWithoutSpikeSecret(request, configured)

  expect(response?.status).toBe(401)
  expect(await response?.json()).toEqual({ error: 'unauthorized' })
})