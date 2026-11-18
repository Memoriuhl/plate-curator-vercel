type VerifiedResearchActor = { uid: string; role: string; active: boolean }
export type ResearchAgentAccessDeps = { actor(request: Request): Promise<VerifiedResearchActor | null>; owner(sessionId: string): Promise<string | null> }

export async function authorizeResearchAgent(request: Request, deps: ResearchAgentAccessDeps) {
  const actor = await deps.actor(request)
  if (!actor || actor.role !== 'owner' || !actor.active) return null
  const match = /\/eve\/v1\/session\/([^/]+)/.exec(new URL(request.url).pathname)
  if (match && await deps.owner(decodeURIComponent(match[1])) !== actor.uid) return null
  return { authenticator: 'plate-curator', principalId: actor.uid, principalType: 'user' as const, attributes: { role: 'owner' }, allowAgentInfo: true }
}
