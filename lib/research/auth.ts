import { authenticate, parseOwnerUids } from '../auth/actor'
import { verifyIdToken } from '../auth/verify-id-token'
import { googleSecureTokenJwks } from '../auth/google-jwks'
import { firestoreMembersStore } from '../members/firestore-store'
import { isActiveOwner, isLiveMember } from '../members/member'
import { authorizeResearchAgent } from './access'
import { researchDatabase, researchEnvironment, researchState } from './storage'
import { firestoreResearchStore } from './firestore-store'
import { verifyResearchServiceToken } from './tokens'
import type { ResearchSessionBinding } from './runtime'

export async function activeResearchMember(uid: string) {
  const member = await firestoreMembersStore(await researchDatabase()).getByUid(uid)
  return isLiveMember(member) && member.status === 'active'
}

export async function activeResearchOwner(uid: string) {
  return isActiveOwner(await firestoreMembersStore(await researchDatabase()).getByUid(uid))
}

export async function researchAgentAuthentication(request: Request) {
  const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!bearer) return null
  const service = await verifyResearchServiceToken(bearer, process.env.RESEARCH_SERVICE_SECRET ?? '', researchEnvironment())
  let jobId: string | undefined
  const state = await researchState()
  const result = await authorizeResearchAgent(request, {
    async actor() {
      if (service) {
        const store = firestoreResearchStore(await researchDatabase(), researchEnvironment())
        const job = await store.transaction(tx => tx.get(service.jobId))
        if (!job || job.requestedBy !== service.uid || job.executor !== 'eve' || !['queued', 'running'].includes(job.state) || job.deadline <= Date.now()) return null
        jobId = job.id
        return { uid: service.uid, role: 'owner', active: await activeResearchOwner(service.uid) }
      }
      if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) return null
      const members = firestoreMembersStore(await researchDatabase())
      const auth = await authenticate(request, { verify: token => verifyIdToken(token, { projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!, jwks: googleSecureTokenJwks() }), ownerUids: parseOwnerUids(process.env.OWNER_UIDS), members })
      return auth.ok ? { ...auth.actor, active: await activeResearchOwner(auth.actor.uid) } : null
    },
    async owner(id) {
      const binding = await state.read<ResearchSessionBinding>(`session/${id}`)
      return binding && (!service || binding.jobId === service.jobId) ? binding.ownerUid : null
    },
  })
  return result && jobId ? { ...result, attributes: { ...result.attributes, jobId } } : result
}
