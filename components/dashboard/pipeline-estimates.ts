'use client'

import useSWR from 'swr'
import { useSession } from '@/lib/client/session'
import { researchModel } from '@/lib/research/models'
import { taggingModel } from '@/lib/tagging/models'
import type { LocalRunStage } from '@/lib/jobs/queue-types'
import type { PipelineOptions } from '@/lib/jobs/pipeline-options'
import { pipelineNeedsModel } from '@/lib/jobs/pipeline-plan'
import { formatDuration } from '@/lib/jobs/run-progress'
import { runTimingKey, type RunTimings } from '@/lib/jobs/run-timings'

const fallbackSeconds: Record<LocalRunStage, number> = {
  research: 90, 'find-image': 20, 'enhance-image': 5, 'wiki-link': 15, colors: 5, describe: 90, story: 130, tag: 40, group: 60,
}

export function useRunTimings(open: boolean) {
  const session = useSession(false)
  const get = session?.api?.get
  return useSWR<RunTimings>(open && session?.user && get ? ['/api/jobs/timings', session.user.uid] : null,
    get ? ([path]: [string, string]) => get(path) : null, { dedupingInterval: 30_000, shouldRetryOnError: false }).data
}

export function estimateStageMs(stage: LocalRunStage, timings: RunTimings | undefined, models: {
  tag?: string; desktop?: string; research?: string
}, options: PipelineOptions = {}) {
  const research = stage === 'research' ? researchModel(models.research) : null
  const tag = stage === 'tag' ? taggingModel(models.tag) : null
  const desktop = stage !== 'tag' && pipelineNeedsModel([{ stage }], options) ? taggingModel(models.desktop) : null
  const device = research?.executor === 'eve' ? 'eve' : tag?.runsOn === 'gateway' ? 'gateway' : 'desktop'
  const model = stage === 'enhance-image' ? 'sharp' : research?.model ?? tag?.model ?? desktop?.model
  return timings?.[runTimingKey(stage, device, model)] ?? (tag?.measured.p50Seconds ?? fallbackSeconds[stage]) * 1000
}

export function formatEstimate(ms: number) {
  return `EST ${formatDuration(Math.ceil(ms / 1000) * 1000)}`
}
