import { expect, test } from 'vitest'
import { authorizeResearchAgent } from '../../lib/research/access'

test('removed members and editors cannot start paid agent sessions', async () => {
  for (const actor of [null, { uid: 'editor', role: 'editor', active: true }, { uid: 'owner', role: 'owner', active: false }]) {
    expect(await authorizeResearchAgent(new Request('https://example.com/eve/v1/session'), { actor: async () => actor, owner: async () => null })).toBeNull()
  }
})

test('session streams and controls require the current owner of that session', async () => {
  const deps = { actor: async () => ({ uid: 'a', role: 'owner', active: true }), owner: async () => 'b' }
  for (const suffix of ['stream', 'cancel', 'clear', 'end']) {
    expect(await authorizeResearchAgent(new Request(`https://example.com/eve/v1/session/other/${suffix}`), deps)).toBeNull()
  }
  expect(await authorizeResearchAgent(new Request('https://example.com/eve/v1/session/own/stream'), { ...deps, owner: async () => 'a' })).toMatchObject({ principalId: 'a', principalType: 'user' })
})

test('owner session creation uses verified identity rather than request-supplied metadata', async () => {
  const auth = await authorizeResearchAgent(new Request('https://example.com/eve/v1/session', { headers: { 'x-user-id': 'someone-else' } }), { actor: async () => ({ uid: 'a', role: 'owner', active: true }), owner: async () => null })
  expect(auth).toMatchObject({ principalId: 'a', attributes: { role: 'owner' } })
})
