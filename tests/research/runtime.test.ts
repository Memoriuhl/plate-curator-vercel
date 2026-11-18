import { expect, test } from 'vitest'
import { authorizeResearchAgent } from '../../lib/research/access'

test('removed members and editors cannot start paid agent sessions', async () => {
  for (const actor of [
    null,
    { uid: 'editor', role: 'editor', active: true },
    { uid: 'owner', role: 'owner', active: false },
  ]) {
    expect(
      await authorizeResearchAgent(
        new Request('https://example.com/eve/v1/session'),
        {
          /** Provide the current test actor so the session authorization case can vary its identity. */ actor:
            async () => actor,
          /** Provide the owner identity that the authorization test can bind to the session. */ owner:
            async () => null,
        }
      )
    ).toBeNull()
  }
})

test('session streams and controls require the current owner of that session', async () => {
  const deps = {
    /** Provide an active owner for the bound-session authorization test. */ actor:
      async () => ({ uid: 'a', role: 'owner', active: true }),
    /** Provide the owner identity that the authorization test can bind to the session. */ owner:
      async () => 'b',
  }
  for (const suffix of ['stream', 'cancel', 'clear', 'end']) {
    expect(
      await authorizeResearchAgent(
        new Request(`https://example.com/eve/v1/session/other/${suffix}`),
        deps
      )
    ).toBeNull()
  }
  expect(
    await authorizeResearchAgent(
      new Request('https://example.com/eve/v1/session/own/stream'),
      {
        ...deps,
        /** Provide the owner identity that the authorization test can bind to the session. */ owner:
          async () => 'a',
      }
    )
  ).toMatchObject({ principalId: 'a', principalType: 'user' })
})

test('owner session creation uses verified identity rather than request-supplied metadata', async () => {
  const auth = await authorizeResearchAgent(
    new Request('https://example.com/eve/v1/session', {
      headers: { 'x-user-id': 'someone-else' },
    }),
    {
      /** Authenticate an active owner while the turn checks its stored session binding. */ actor:
        async () => ({ uid: 'a', role: 'owner', active: true }),
      /** Provide the owner identity that the authorization test can bind to the session. */ owner:
        async () => null,
    }
  )
  expect(auth).toMatchObject({
    principalId: 'a',
    attributes: { role: 'owner' },
  })
})
