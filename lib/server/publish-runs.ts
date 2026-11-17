import { getHookByToken, getRun } from 'workflow/api'
import { HookNotFoundError, WorkflowRunNotFoundError } from 'workflow/errors'
import { publishStartToken } from '../publish/command'
import type { PublishRunLookup } from '../publish/eligibility'

export function workflowPublishRunLookup(): PublishRunLookup {
  const runStatus = async (runId: string) => {
    try { return await getRun(runId).status } catch (error) {
      if (WorkflowRunNotFoundError.is(error)) return 'not_found'
      throw error
    }
  }
  return { runStatus, findRun: async commandId => {
    try {
      const hook = await getHookByToken(publishStartToken(commandId))
      return { runId: hook.runId, status: await runStatus(hook.runId) }
    } catch (error) {
      if (HookNotFoundError.is(error)) return null
      throw error
    }
  } }
}
