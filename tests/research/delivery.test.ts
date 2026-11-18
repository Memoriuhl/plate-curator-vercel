import { expect, test, vi } from 'vitest'
import { createEveResearchDelivery } from '../../lib/research/delivery'
import { researchFixture } from './fixture'

/** Start a real in-memory research job for constructing the hosted delivery request. */
async function job() {
  const result = await researchFixture().start('delivery', 'eve')
  if (!result.ok) throw new Error('setup')
  return result.value
}

test('protected same-deployment handoffs carry both scoped job auth and deployment auth', async () => {
  let headers: Headers | undefined
  const result = await createEveResearchDelivery(await job(), {
    baseUrl: 'https://preview.example.com',
    deploymentHost: 'preview.example.com',
    secret: 'fixture-secret-at-least-thirty-two-characters',
    /** Supply the deployment credential expected to reach the protected hosted delivery endpoint. */ trustedOidc:
      async () => 'fixture-deployment-token',
    fetch: (async (_url, init) => {
      headers = new Headers(init?.headers)
      return Response.json({ sessionId: 'session', deliveryId: 'delivery' })
    }) as typeof fetch,
  })
  expect(result).toEqual({ sessionId: 'session', deliveryId: 'delivery' })
  expect(headers?.get('authorization')).toMatch(/^Bearer /)
  expect(headers?.get('x-vercel-trusted-oidc-idp-token')).toBe(
    'fixture-deployment-token'
  )
})

test('an external configured agent never receives the deployment credential', async () => {
  const oidc = vi.fn(async () => 'private-deployment-credential')
  await createEveResearchDelivery(await job(), {
    baseUrl: 'https://agent.example.com',
    deploymentHost: 'preview.example.com',
    secret: 'fixture-secret-at-least-thirty-two-characters',
    trustedOidc: oidc,
    fetch: (async (_url, init) => {
      expect(
        new Headers(init?.headers).has('x-vercel-trusted-oidc-idp-token')
      ).toBe(false)
      return Response.json({ sessionId: 'session', deliveryId: 'delivery' })
    }) as typeof fetch,
  })
  expect(oidc).not.toHaveBeenCalled()
})
