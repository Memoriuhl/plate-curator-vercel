import { expect, test, vi } from 'vitest'
import { searchProviderHealth } from '../../lib/research/provider-health'

const serperKey = 'serper-secret-value'
const braveKey = 'brave-secret-value'

/** Answer each provider host with its own canned response. */
function respond(responses: {
  serper?: () => Response | Promise<Response>
  brave?: () => Response | Promise<Response>
}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const handler = url.includes('serper.dev')
      ? responses.serper
      : responses.brave
    if (!handler) throw Error(`unexpected request ${url}`)
    return handler()
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

test('a missing key names the env var and makes no request', async () => {
  const fetch = respond({})
  const health = await searchProviderHealth({ keys: {}, probe: true, fetch })
  expect(health.providers).toEqual([
    expect.objectContaining({
      provider: 'serper',
      envVar: 'SERPER_API_KEY',
      status: 'missing_key',
      checked: false,
    }),
    expect.objectContaining({
      provider: 'brave',
      envVar: 'BRAVE_API_KEY',
      status: 'missing_key',
      checked: false,
    }),
  ])
  expect(fetch).not.toHaveBeenCalled()
})

test('without a probe, a present key is reported as configured only', async () => {
  const fetch = respond({})
  const health = await searchProviderHealth({
    keys: { serper: serperKey, brave: braveKey },
    probe: false,
    fetch,
  })
  expect(health.providers.map((p) => [p.status, p.checked])).toEqual([
    ['configured', false],
    ['configured', false],
  ])
  expect(fetch).not.toHaveBeenCalled()
})

test('a probe reports each provider as available with its remaining quota', async () => {
  const fetch = respond({
    serper: () => Response.json({ organic: [{ link: 'https://a.example' }] }),
    brave: () =>
      Response.json(
        { web: { results: [{ url: 'https://b.example' }] } },
        {
          headers: {
            'X-RateLimit-Limit': '1, 2000',
            'X-RateLimit-Remaining': '0, 1990',
          },
        }
      ),
  })
  const health = await searchProviderHealth({
    keys: { serper: serperKey, brave: braveKey },
    probe: true,
    fetch,
  })
  expect(health.providers).toEqual([
    expect.objectContaining({ status: 'available', checked: true }),
    expect.objectContaining({
      status: 'available',
      checked: true,
      quota: { limit: '1, 2000', remaining: '0, 1990' },
    }),
  ])
  expect(fetch).toHaveBeenCalledTimes(2)
})

test.each([
  {
    name: 'a rejected Serper key',
    serper: () =>
      Response.json(
        { message: 'Unauthorized.', statusCode: 403 },
        { status: 403 }
      ),
    status: 'auth_failed',
  },
  {
    name: 'Serper without credits',
    serper: () =>
      Response.json(
        { message: 'Not enough credits', statusCode: 400 },
        { status: 400 }
      ),
    status: 'over_quota',
  },
  {
    name: 'an unreachable Serper',
    serper: () => Promise.reject(new TypeError('fetch failed')),
    status: 'unreachable',
  },
  {
    name: 'an unexpected Serper error',
    serper: () => new Response('upstream', { status: 502 }),
    status: 'error',
  },
])('a probe classifies $name', async (row) => {
  const health = await searchProviderHealth({
    keys: { serper: serperKey },
    probe: true,
    fetch: respond({ serper: row.serper }),
  })
  expect(health.providers[0]).toMatchObject({
    provider: 'serper',
    status: row.status,
    checked: true,
  })
})

test.each([
  {
    name: 'an invalid Brave token',
    status: 422,
    code: 'SUBSCRIPTION_TOKEN_INVALID',
    expected: 'auth_failed',
  },
  {
    name: 'a used-up Brave plan',
    status: 429,
    code: 'QUOTA_LIMITED',
    expected: 'over_quota',
  },
  {
    name: 'a Brave per-second limit',
    status: 429,
    code: 'RATE_LIMITED',
    expected: 'rate_limited',
  },
])('a probe classifies $name', async (row) => {
  const health = await searchProviderHealth({
    keys: { brave: braveKey },
    probe: true,
    fetch: respond({
      brave: () =>
        Response.json(
          {
            type: 'ErrorResponse',
            error: { code: row.code, detail: 'Request limit exceeded.' },
          },
          { status: row.status }
        ),
    }),
  })
  expect(health.providers[1]).toMatchObject({
    provider: 'brave',
    status: row.expected,
    httpStatus: row.status,
  })
})

test('a probe never returns key material, even when the provider echoes it', async () => {
  const health = await searchProviderHealth({
    keys: { serper: serperKey, brave: braveKey },
    probe: true,
    fetch: respond({
      serper: () =>
        Response.json({ message: `Invalid key ${serperKey}` }, { status: 401 }),
      brave: () =>
        Response.json(
          { error: { code: 'X', detail: `token ${braveKey} rejected` } },
          { status: 401 }
        ),
    }),
  })
  const text = JSON.stringify(health)
  expect(text).not.toContain(serperKey)
  expect(text).not.toContain(braveKey)
  expect(health.providers.map((p) => p.status)).toEqual([
    'auth_failed',
    'auth_failed',
  ])
})

test('the Gateway search mode is reported so absent keys are not a fault', async () => {
  const health = await searchProviderHealth({
    keys: {},
    probe: false,
    mode: 'gateway-parallel',
  })
  expect(health.mode).toBe('gateway-parallel')
})
