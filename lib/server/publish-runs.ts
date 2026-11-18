import { getHookByToken, getRun } from 'workflow/api'
import { HookNotFoundError, WorkflowRunNotFoundError } from 'workflow/errors'
import { publishStartToken } from '../publish/command'
import type { PublishRunLookup } from '../publish/eligibility'

/** Adapt workflow run status and start-hook lookups for publish recovery. */
export function workflowPublishRunLookup(): PublishRunLookup {
  /**
   * Read the workflow runtime status and translate a missing run into a distinct
   * outcome.
   */
  const runStatus = async (runId: string) => {
    try { return await getRun(runId).status } catch (error) {
      if (WorkflowRunNotFoundError.is(error)) return 'not_found'
      throw error
    }
  }
  return { runStatus, /** Find a publish workflow by its command start token when the receipt lacks a run ID. */ findRun: async commandId => {
    try {
      const hook = await getHookByToken(publishStartToken(commandId))
      return { runId: hook.runId, status: await runStatus(hook.runId) }
    } catch (error) {
      if (HookNotFoundError.is(error)) return null
      throw error
    }
  } }
}
