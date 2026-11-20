import { reportJobPhase } from '../jobs/job-phase'
import type { JobsDeps, TaggingJob } from '../jobs/types'
import { expireJob, getJob, reportResult } from '../jobs/jobs'
import { failLocalJob } from '../jobs/queue/queue-failure'
import type { ResearchStateStore } from './state'
import type {
  EvidenceSource,
  ResearchDraft,
  ResearchInput,
  ResearchRejection,
} from './types'
import { enrichmentTargets } from './enrichment'
import {
  enrichmentNotes,
  enrichmentPrompt,
  enrichmentPromptVersion,
  enrichmentSuggestion,
  needsEnrichmentSynthesis,
  wikiOnlyDraft,
} from './enrichment-result'
import {
  prepareEnrichment,
  type captureEnrichment,
  type captureSavedEnrichment,
  type PreparedEnrichment,
} from '../../worker/pipeline/research'
import { researchModelCosts } from './models/model-attempt'
import { LEGACY_RESEARCH_PRICES } from './models/models'
import type { StoryRetry, StoryRetryInput } from './story-retry'
import { STRICT_MODEL_FAILURE } from '../models/routing'

export type QueueResearchDeps = {
  state: ResearchStateStore
  activeOwner(uid: string): Promise<boolean>
  capture?: typeof captureEnrichment
  captureSaved?: typeof captureSavedEnrichment
  deliver(
    job: TaggingJob,
    input: ResearchInput,
    message: string
  ): Promise<{ sessionId: string; deliveryId: string }>
  /** One retry when the first draft lacks the requested description or story. */
  retry?: StoryRetry
}

// One queue job owns this Eve session. There is no parallel research-job ledger
// and no second acceptance path: completion becomes a normal queue suggestion.
/**
 * Run the hosted enrichment stage for an authorized queue job and reuse captured
 * evidence across polls.
 */
export async function executeQueueResearch(
  jobs: JobsDeps,
  job: TaggingJob,
  deps: QueueResearchDeps
): Promise<'waiting' | 'settled'> {
  if (!(await deps.activeOwner(job.requestedBy)))
    throw Error('Research requester is no longer an active Owner')
  if (
    !job.researchModel ||
    job.researchModel.executor !== 'eve' ||
    !job.inputPlate ||
    job.stage !== 'research' ||
    job.state !== 'claimed'
  )
    throw Error('Invalid hosted research job')
  const plate = job.inputPlate
  const policy = job.researchPolicy ?? 'fill-missing'
  const fields = enrichmentTargets(plate, policy)
  const meta = {
    backend: 'eve',
    model: job.researchModel.model,
    promptVersion: enrichmentPromptVersion,
  }
  /**
   * Convert the draft into a stage suggestion and report it through the job's current
   * claim.
   */
  async function report(
    draft: unknown,
    sources: EvidenceSource[],
    usage: Record<string, number>,
    skippedPhases: number[] = [],
    servedModel?: string,
    rejected: ResearchRejection[] = [],
    synthesized = false
  ) {
    if (draft && sources.length)
      await reportJobPhase(
        jobs,
        'hosted',
        job.id,
        job.claimId!,
        2,
        skippedPhases
      )
    const fieldSuggestion = enrichmentSuggestion(draft, sources, plate, policy)
    const researchNotes = synthesized
      ? enrichmentNotes(draft, sources, plate, policy, rejected)
      : []
    const result = await reportResult(jobs, 'hosted', job.id, job.claimId!, {
      ...meta,
      model: servedModel ?? meta.model,
      usage,
      durationMs: Math.max(0, jobs.now() - (job.startedAt ?? job.createdAt)),
      ...(skippedPhases.length ? { skippedPhases } : {}),
      ...(researchNotes.length ? { researchNotes } : {}),
      ...(fieldSuggestion
        ? { fieldSuggestion }
        : {
            stageError: sources.length ? 'no_supported_fields' : 'no_sources',
          }),
    })
    if (!result.ok) throw Error(`Research report refused: ${result.error}`)
    return 'settled' as const
  }
  if (!fields.length) return report(null, [], { modelCalls: 0 })
  // Persist captured evidence by job so later workflow polls can reuse it.
  let prepared = await deps.state.read<PreparedEnrichment>(
    `pipeline-evidence/${job.id}`
  )
  if (!prepared) {
    prepared = await prepareEnrichment(
      plate,
      { ...job.stageOptions, policy },
      deps
    )
    await deps.state.update(`pipeline-evidence/${job.id}`, () => ({
      value: prepared,
      result: null,
    }))
    await deps.state.update(`evidence/${job.id}`, () => ({
      value: prepared!.sources,
      result: null,
    }))
  }
  const skippedPhases = prepared.sourceLookupSkipped ? [0] : []
  if (!prepared.sources.length)
    return report(null, [], { modelCalls: 0 }, skippedPhases)
  if (!needsEnrichmentSynthesis(plate, policy))
    return report(
      wikiOnlyDraft(prepared.sources, prepared.wikiUrl),
      prepared.sources,
      { modelCalls: 0 },
      [...skippedPhases, 1]
    )
  await reportJobPhase(jobs, 'hosted', job.id, job.claimId!, 1, skippedPhases)
  if (!job.eve) {
    const run = (await jobs.store.transaction((tx) => tx.runs())).find(
      (run) => run.id === job.queueRunId
    )!
    const input: ResearchInput = {
      plateId: plate.id,
      displayName: plate.displayName,
      state: plate.state,
      inputRevision: job.executionHash!,
      baselineVersion: run.attempts.at(-1)!.projection!.baselineVersion,
    }
    const receipt = await deps.deliver(
      job,
      input,
      `${enrichmentPrompt(plate, prepared.sources, policy, fields)}\nCall submit_draft directly with the structured result. Captured evidence is already registered. Do not emit Python or use an interpreter.`
    )
    await jobs.store.transaction(async (tx) => {
      const current = await tx.get(job.id)
      if (
        current?.state === 'claimed' &&
        current.claimId === job.claimId &&
        !current.eve
      )
        tx.set({ ...current, eve: receipt })
    })
  }
  const settled = await deps.state.read<{ outcome: string; error?: string }>(
    `eve-outcome/${job.id}`
  )
  if (settled && job.leaseExpiresAt! <= jobs.now()) {
    await expireJob(jobs, job.id)
    return 'settled'
  }
  if (settled) {
    const output = await deps.state.read<{
      draft: ResearchDraft
      rejected?: ResearchRejection[]
    }>(`draft/${job.id}`)
    if (!output) {
      const result = await failLocalJob(
        jobs,
        'hosted',
        job.id,
        job.claimId!,
        settled.error === 'research_budget_exhausted' ||
          settled.error === STRICT_MODEL_FAILURE
          ? settled.error
          : 'stage_failed'
      )
      if (!result.ok)
        throw Error(
          `Could not record the hosted research failure: ${result.error}`
        )
      return 'settled'
    }
    const usage =
      (await deps.state.read<Record<string, number>>(`usage/${job.id}`)) ?? {}
    const servedModel = await deps.state.read<string>(`served-model/${job.id}`)
    let { draft: firstDraft } = output
    let rejected = output.rejected ?? []
    if (missingContent(firstDraft, fields) && deps.retry) {
      const retried = await retryDraft(jobs, job, deps.retry, {
        deadline:
          (await deps.state.read<number>(`deadline/${job.id}`)) ??
          job.leaseExpiresAt!,
        prompt: `${enrichmentPrompt(plate, prepared.sources, policy, fields)}\nCall submit_draft directly with the structured result.`,
        sources: prepared.sources,
      })
      if (
        retried &&
        missingContent(retried.draft, fields) <
          missingContent(firstDraft, fields)
      ) {
        firstDraft = retried.draft
        rejected = retried.rejected
      }
    }
    const costs = await researchModelCosts(deps.state, job.id)
    // Use the captured matched Wiki even when the model only found text/facts.
    const draft = {
      ...firstDraft,
      wikiSource:
        firstDraft.wikiSource ??
        output.draft.wikiSource ??
        wikiOnlyDraft(prepared.sources, prepared.wikiUrl).wikiSource,
    }
    return report(
      draft,
      prepared.sources,
      {
        ...usage,
        modelCalls: costs.modelAttempts,
        costUsd: costs.costUsd,
        missingModelCosts: costs.missingModelCosts,
      },
      skippedPhases,
      servedModel ?? undefined,
      rejected,
      true
    )
  }
  if ((await getJob(jobs, job.id))?.state !== 'claimed') return 'settled'
  return 'waiting'
}

/** Count the requested description and story fields the draft left empty. */
function missingContent(draft: ResearchDraft, fields: string[]) {
  return (
    Number(fields.includes('description') && !draft.description) +
    Number(fields.includes('funFacts') && !draft.funFacts.length)
  )
}

/** Retry the draft once with the run's research model and price binding. */
async function retryDraft(
  jobs: JobsDeps,
  job: TaggingJob,
  retry: StoryRetry,
  input: Pick<StoryRetryInput, 'deadline' | 'prompt' | 'sources'>
) {
  const run = await jobs.store.transaction((tx) => tx.getRun(job.queueRunId!))
  const binding = run?.modelBindings?.research
  const model = binding?.model ?? job.researchModel!.model
  const price =
    binding?.price ??
    LEGACY_RESEARCH_PRICES[model as keyof typeof LEGACY_RESEARCH_PRICES]
  if (!price) return null
  return retry({
    ...input,
    jobId: job.id,
    model,
    price: { price, outputTokensBound: binding?.outputTokensBound },
  })
}
