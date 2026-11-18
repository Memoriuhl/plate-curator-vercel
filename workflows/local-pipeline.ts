import { createHook, getWorkflowMetadata, sleep } from 'workflow'
import { bindQueueWorkflow, dispatchQueueStage, observeQueueStage } from '../lib/jobs/queue-engine'
import { jobsDeps } from '../lib/server/context'

export async function localPipelineRun(id: string, attempt: number, startIndex: number, stepCount: number) {
  'use workflow'
  const { workflowRunId } = getWorkflowMetadata()
  if (!await bind(id, attempt, workflowRunId)) return { outcome: 'superseded' }
  for (let index = startIndex; index < stepCount; index++) {
    using hook = createHook<{ jobId?: string }>({ token: `local-pipeline:${id}:${attempt}:${index}` })
    if (await hook.getConflict()) return { outcome: 'hook_conflict' }
    if (!await dispatch(id, attempt, index, hook.token)) return { outcome: 'stopped' }
    const events = hook[Symbol.asyncIterator]()
    let event = events.next()
    for (;;) {
      const state = await observe(id, attempt, index)
      if (state.phase === 'done') return { outcome: 'settled' }
      if (state.phase === 'next') break
      const timer = state.phase === 'claimed' && state.deadline ? sleep(new Date(state.deadline)) : sleep('1h')
      const wake = await Promise.race([event.then(() => 'event' as const), timer.then(() => 'timer' as const)])
      if (wake === 'event') event = events.next()
    }
  }
  return { outcome: 'completed' }
}

async function bind(id: string, attempt: number, workflowId: string) {
  'use step'
  return bindQueueWorkflow(jobsDeps(), id, attempt, workflowId)
}

async function dispatch(id: string, attempt: number, index: number, token: string) {
  'use step'
  return dispatchQueueStage(jobsDeps(), id, attempt, index, token)
}

async function observe(id: string, attempt: number, index: number) {
  'use step'
  return observeQueueStage(jobsDeps(), id, attempt, index)
}
