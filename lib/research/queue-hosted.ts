import { reportJobPhase } from '../jobs/job-phase'
import type { JobsDeps, TaggingJob } from '../jobs/types'
import { expireJob, getJob, reportResult } from '../jobs/jobs'
import { failLocalJob } from '../jobs/queue-failure'
import type { ResearchStateStore } from './state'
import type { EvidenceSource, ResearchDraft, ResearchInput } from './types'
import { enrichmentTargets } from './enrichment'
import {
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
import { researchModelCosts } from './model-attempt'

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
    skippedPhases: number[] = []
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
    const result = await reportResult(jobs, 'hosted', job.id, job.claimId!, {
      ...meta,
      usage,
      durationMs: Math.max(0, jobs.now() - (job.startedAt ?? job.createdAt)),
      ...(skippedPhases.length ? { skippedPhases } : {}),
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
    const output = await deps.state.read<{ draft: ResearchDraft }>(
      `draft/${job.id}`
    )
    if (!output) {
      const result = await failLocalJob(
        jobs,
        'hosted',
        job.id,
        job.claimId!,
        settled.error === 'research_budget_exhausted'
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
    const costs = await researchModelCosts(deps.state, job.id)
    // Use the captured matched Wiki even when the model only found text/facts.
    const draft = {
      ...output.draft,
      wikiSource:
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
      skippedPhases
    )
  }
  if ((await getJob(jobs, job.id))?.state !== 'claimed') return 'settled'
  return 'waiting'
}
