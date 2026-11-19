import { researchState } from './storage'
import { reserveResearchCall, type ResearchCall } from './limits'
import { saveEvidence } from './evidence'
import type {
  EvidenceSource,
  ResearchContentField,
  ResearchInput,
  ResearchResult,
} from './types'
import { validateResearchResult } from './validate'
import type { ResearchStateStore } from './state'
import { createResearchModelAttempt } from './model-attempt'
import { reserveResearchSpend } from './budget'
import { DEFAULT_HOSTED_RESEARCH_MODEL } from './models'
import { researchContentFields, researchOutcome } from './outcome'
import { enrichmentTargets } from './enrichment'
import type { HostedModelBinding } from '../models/selection'

type SessionContext = {
  session: {
    id: string
    turn: { id: string }
    auth?: { current: { principalId: string; authenticator: string } | null }
  }
}
export type ResearchSessionBinding = {
  ownerUid: string
  jobId?: string
  pipelineJobId?: string
  model?: string
  input?: ResearchInput
}

/**
 * Resolve the research turn's session, authorization and state so tools share its limits
 * and evidence.
 */
export async function researchTurn(
  ctx: SessionContext,
  providedStore?: ResearchStateStore
) {
  const store = providedStore ?? (await researchState())
  const binding = await store.read<ResearchSessionBinding>(
    `session/${ctx.session.id}`
  )
  if (!providedStore) {
    const principal = ctx.session.auth?.current
    const local =
      process.env.EVE_DEV === '1' &&
      !process.env.VERCEL &&
      principal?.authenticator === 'local-dev'
    if (!local) {
      const { activeResearchOwner } = await import('./auth')
      if (
        !principal ||
        !binding ||
        binding.ownerUid !== principal.principalId ||
        !(await activeResearchOwner(principal.principalId))
      )
        throw new Error('Research caller is no longer an active Owner')
    }
  }
  const runId =
    binding?.pipelineJobId ??
    binding?.jobId ??
    `${ctx.session.id}/${ctx.session.turn.id}`
  let jobDeadline: number | undefined
  let model: string = DEFAULT_HOSTED_RESEARCH_MODEL
  let hostedModel: HostedModelBinding | undefined
  // Judge the draft against what this plate lacked; unknown requests need both fields.
  let requested: ResearchContentField[] | undefined = binding?.input?.requested
  if (binding?.pipelineJobId && !providedStore) {
    const { pipelineResearchStore } = await import('./pipeline-context')
    const deps = await pipelineResearchStore()
    const job = await deps.store.transaction((tx) =>
      tx.get(binding.pipelineJobId!)
    )
    const run = job?.queueRunId
      ? await deps.store.transaction((tx) => tx.getRun(job.queueRunId!))
      : null
    const runModel =
      run?.modelBindings?.research?.model ?? run?.researchModel?.model
    if (
      !job ||
      job.localScope !== deps.scope ||
      job.route !== 'hosted' ||
      job.stage !== 'research' ||
      job.state !== 'claimed' ||
      job.requestedBy !== binding.ownerUid ||
      !runModel ||
      job.researchModel?.model !== runModel ||
      !run ||
      !['queued', 'running'].includes(run.status) ||
      run.cancelRequestedAt !== undefined
    )
      throw Error('Pipeline research is no longer active')
    model = runModel
    hostedModel = run.modelBindings?.research
    jobDeadline = job.leaseExpiresAt
    const targets = enrichmentTargets(
      job.inputPlate ?? {},
      job.researchPolicy ?? 'fill-missing'
    )
    requested = researchContentFields.filter((field) => targets.includes(field))
  }
  if (binding?.jobId && !providedStore) {
    const { researchDatabase, researchEnvironment } = await import('./storage')
    const { firestoreResearchStore } = await import('./firestore-store')
    const job = await firestoreResearchStore(
      await researchDatabase(),
      researchEnvironment()
    ).transaction((tx) => tx.get(binding.jobId!))
    if (
      !job ||
      job.executor !== 'eve' ||
      job.requestedBy !== binding.ownerUid ||
      !['queued', 'running'].includes(job.state)
    )
      throw new Error('Research request is no longer active')
    model = job.hostedModel?.model ?? job.model
    hostedModel = job.hostedModel
    jobDeadline = job.deadline
  }
  const deadline = await store.update<number, number>(
    `deadline/${runId}`,
    (prior) => {
      const value = prior ?? jobDeadline ?? Date.now() + 300000
      return { value, result: value }
    }
  )
  return {
    store,
    runId,
    deadline,
    binding,
    model,
    hostedModel,
    requested,
    /**
     * Open a budgeted model attempt for the current research run using its configured
     * constraints.
     */
    modelAttempt: () =>
      createResearchModelAttempt(store, runId, {
        campaign: process.env.RESEARCH_BUDGET_ID ?? 'eve-research-1117',
        limitUsd: Number(process.env.RESEARCH_BUDGET_USD ?? '2'),
        deadline,
        // Captured synthesis is text-only, with one call, a 60 kB input bound
        // and at most 1,000 output tokens. Two cents covers both allowed models
        // at current Gateway rates with margin over the request bounds.
        ...(binding?.pipelineJobId
          ? { maxCalls: 1, reservationUsd: 0.02 }
          : {}),
      }),
    /**
     * Reserve a tool call against the session or pipeline job budget before requesting
     * evidence.
     */
    async reserve(kind: ResearchCall) {
      if (binding?.pipelineJobId) return false // Captured evidence only; no nested search or control calls.
      if (
        (await reserveResearchCall(runId, kind, {
          store,
          now: Date.now,
          deadline,
        })) !== 'reserved'
      )
        return false
      if (kind !== 'model' && kind !== 'web-search') return true
      return reserveResearchSpend(
        store,
        process.env.RESEARCH_BUDGET_ID ?? 'eve-research-1117',
        runId,
        kind === 'model' ? 'model' : 'search',
        kind === 'model' ? 0.2 : 0.01,
        Number(process.env.RESEARCH_BUDGET_USD ?? '2')
      )
    },
    /** Persist captured evidence under the current run so the draft can cite it. */
    async evidence(source: EvidenceSource) {
      return saveEvidence(store, runId, source)
    },
  }
}

/**
 * Validate a submitted draft against the turn's evidence and store the normalized
 * result.
 */
export async function submitResearchDraft(
  ctx: SessionContext,
  raw: unknown,
  providedStore?: ResearchStateStore
) {
  const runtime = await researchTurn(ctx, providedStore)
  const sources =
    (await runtime.store.read<EvidenceSource[]>(`evidence/${runtime.runId}`)) ??
    []
  const { draft, rejected } = validateResearchResult(raw, sources)
  const result = { draft, rejected, sources }
  await runtime.store.update(`draft/${runtime.runId}`, () => ({
    value: result,
    result: null,
  }))
  return {
    ...researchOutcome(draft, sources, runtime.requested),
    ...result,
  }
}

/**
 * Assemble the hosted result with input identity, evidence and observed execution
 * metrics.
 */
export function hostedResearchResult(
  input: ResearchInput,
  output: {
    draft: ResearchResult['draft']
    sources: EvidenceSource[]
    rejected: ResearchResult['rejected']
  },
  details: {
    durationMs: number
    counters: Record<string, number>
    model?: string
  }
): ResearchResult {
  return {
    input,
    ...output,
    ...details,
    provenance: {
      executor: 'eve',
      model: details.model ?? DEFAULT_HOSTED_RESEARCH_MODEL,
      promptVersion: 'research-v1',
      codeRevision: process.env.VERCEL_GIT_COMMIT_SHA ?? 'development',
    },
    attempts: [],
    ...researchOutcome(output.draft, output.sources, input.requested),
    cost: { usd: null, missing: 1 },
    cache: 'unknown',
  }
}
