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

/** Check that the named research member currently has active access. */
export async function activeResearchMember(uid: string) {
  const member = await firestoreMembersStore(await researchDatabase()).getByUid(
    uid
  )
  return isLiveMember(member) && member.status === 'active'
}

/** Resolve current owner authority for hosted research operations. */
export async function activeResearchOwner(uid: string) {
  return isActiveOwner(
    await firestoreMembersStore(await researchDatabase()).getByUid(uid)
  )
}

/**
 * Authenticate research requests through either a verified user identity or a service
 * token.
 */
export async function researchAgentAuthentication(request: Request) {
  const bearer = /^Bearer ([^\s]+)$/i.exec(
    request.headers.get('authorization') ?? ''
  )?.[1]
  if (!bearer) return null
  const service = await verifyResearchServiceToken(
    bearer,
    process.env.RESEARCH_SERVICE_SECRET ?? '',
    researchEnvironment()
  )
  let jobId: string | undefined
  let pipelineJobId: string | undefined
  const { pipelineResearchStore } = await import('./pipeline-context')
  const queue =
    process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
      ? await pipelineResearchStore()
      : null
  const pipelineService =
    !service && queue
      ? await verifyResearchServiceToken(
          bearer,
          process.env.RESEARCH_SERVICE_SECRET ?? '',
          queue.store.env
        )
      : null
  const state = await researchState()
  const result = await authorizeResearchAgent(request, {
    /**
     * Resolve the actor and enforce the current owner or pipeline job scope for the
     * presented credential.
     */
    async actor() {
      if (pipelineService && queue) {
        const job = await queue.store.transaction((tx) =>
          tx.get(pipelineService.jobId)
        )
        if (
          !job ||
          job.localScope !== queue.scope ||
          job.requestedBy !== pipelineService.uid ||
          job.route !== 'hosted' ||
          job.stage !== 'research' ||
          job.state !== 'claimed' ||
          job.leaseExpiresAt! <= Date.now()
        )
          return null
        pipelineJobId = job.id
        return {
          uid: pipelineService.uid,
          role: 'owner',
          active: await activeResearchOwner(pipelineService.uid),
        }
      }
      if (service) {
        const store = firestoreResearchStore(
          await researchDatabase(),
          researchEnvironment()
        )
        const job = await store.transaction((tx) => tx.get(service.jobId))
        if (
          !job ||
          job.requestedBy !== service.uid ||
          job.executor !== 'eve' ||
          !['queued', 'running'].includes(job.state) ||
          job.deadline <= Date.now()
        )
          return null
        jobId = job.id
        return {
          uid: service.uid,
          role: 'owner',
          active: await activeResearchOwner(service.uid),
        }
      }
      if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) return null
      const members = firestoreMembersStore(await researchDatabase())
      const auth = await authenticate(request, {
        /** Verify the user's Firebase token with the research project's expected issuer and public keys. */ verify:
          (token) =>
            verifyIdToken(token, {
              projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
              jwks: googleSecureTokenJwks(),
            }),
        ownerUids: parseOwnerUids(process.env.OWNER_UIDS),
        members,
      })
      return auth.ok
        ? { ...auth.actor, active: await activeResearchOwner(auth.actor.uid) }
        : null
    },
    /**
     * Read the session binding and expose its owner only within the authenticated
     * pipeline scope.
     */
    async owner(id) {
      const binding = await state.read<ResearchSessionBinding>(`session/${id}`)
      return binding &&
        (!service || binding.jobId === service.jobId) &&
        (!pipelineService || binding.pipelineJobId === pipelineService.jobId)
        ? binding.ownerUid
        : null
    },
  })
  return result && (jobId || pipelineJobId)
    ? {
        ...result,
        attributes: {
          ...result.attributes,
          ...(jobId ? { jobId } : {}),
          ...(pipelineJobId ? { pipelineJobId } : {}),
        },
      }
    : result
}
