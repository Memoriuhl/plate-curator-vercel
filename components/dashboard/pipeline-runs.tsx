'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { IoChevronDown } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useSession } from '@/lib/client/session'
import { useMe } from '@/lib/client/hooks'
import type { GatewayRun } from '@/lib/jobs/gateway-runs'
import { queueProgress } from '@/lib/jobs/run-progress'
import { taggingModel } from '@/lib/tagging/models'
import type { usePipelineQueue } from './use-pipeline-queue'
import { PipelineQueuePanel } from './pipeline-queue-panel'
import { PipelineRunCard } from './pipeline-run-card'
import styles from './pipeline-runs.module.css'

export function PipelineRuns({ queue }: { queue: ReturnType<typeof usePipelineQueue> }) {
  const local = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
  const [view, setView] = useState(local ? 'local' : 'gateway')
  const { user, api } = useSession()
  const me = useMe()
  const gateway = useSWR<{ runs: GatewayRun[]; observedAt: number }>(user ? '/api/jobs/runs' : null, api.get, { refreshInterval: view === 'gateway' ? 3000 : 0 })
  const gatewayRuns = gateway.data?.runs ?? []
  const workers = [...new Set(queue.runs.flatMap(run => (run.progress ?? queueProgress(run)).workerIds))]
  const worker = view.startsWith('worker:') ? view.slice(7) : undefined
  const isGateway = view === 'gateway'
  const modelNames = [...new Set(gatewayRuns.map(run => taggingModel(run.modelId)?.label ?? run.modelId).filter(Boolean))]
  const subtitle = isGateway ? modelNames.join(' · ') || 'No saved gateway runs' : worker ?? (workers.length === 1 ? workers[0] : workers.length ? 'All local workers' : 'Waiting for a worker')
  const header = <div className={styles.header}>
    <h2 className="sr-only">Pipeline runs</h2>
    <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={styles.device} aria-label={`View runs: ${isGateway ? 'Vercel Gateway' : 'Local PC'}. ${subtitle}`}>
      <span><strong>{isGateway ? 'Vercel Gateway' : 'Local PC'}</strong><small>{subtitle}</small></span><IoChevronDown aria-hidden="true" />
    </button></DropdownMenuTrigger><DropdownMenuContent align="end" className="min-w-64 max-w-[calc(100vw-2rem)]"><DropdownMenuGroup><DropdownMenuLabel>View runs</DropdownMenuLabel><DropdownMenuRadioGroup value={view} onValueChange={setView}>
      {local ? <DropdownMenuRadioItem value="local">Local PC · all workers</DropdownMenuRadioItem> : null}
      {local && workers.length > 1 ? workers.map(id => <DropdownMenuRadioItem key={id} value={`worker:${id}`}>{id}</DropdownMenuRadioItem>) : null}
      <DropdownMenuRadioItem value="gateway"><span className="flex flex-col gap-1"><span>Vercel Gateway</span><small>{modelNames.join(' · ') || 'Hosted tagging runs'}</small></span></DropdownMenuRadioItem>
    </DropdownMenuRadioGroup></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
  </div>
  const requester = (uid: string) => uid === me.data?.uid ? me.data.name ?? 'You' : undefined
  if (!isGateway) {
    const runs = worker ? queue.runs.filter(run => (run.progress ?? queueProgress(run)).workerIds.includes(worker)) : queue.runs
    return <PipelineQueuePanel header={header} requester={requester} queue={{ ...queue, runs, selected: queue.selected && runs.some(run => run.id === queue.selected?.id) ? queue.selected : undefined }} />
  }
  return <section className={styles.panel} aria-label="Gateway pipeline runs">{header}
    {gateway.isLoading ? <p role="status" className="caption">Loading gateway runs…</p> : gateway.error ? <p role="alert">Could not load gateway runs. <Button size="sm" variant="ghost" onClick={() => void gateway.mutate()}>Refresh runs</Button></p> : !gatewayRuns.length ? <p className="caption">No gateway runs in this environment yet. Switching views does not start or move a run.</p> : null}
    {gatewayRuns.map(run => <PipelineRunCard key={run.id} run={run} progress={run.progress} stages={['tag']} observedAt={gateway.data?.observedAt} requester={requester(run.requestedBy)}>
      <details className={styles.activity}><summary>Run activity</summary><p>Requested {new Date(run.createdAt).toLocaleString()} · {run.status} · {taggingModel(run.modelId)?.label ?? run.modelId}</p><p>Run reference: {run.id}</p>
        {run.results.length ? <ul className={styles.stepList}>{run.results.map(result => <li key={result.jobId}><strong>{result.plateName}</strong><span>Suggested tags: {result.suggestions.join(', ') || 'None'}</span></li>)}</ul> : null}
      </details>
    </PipelineRunCard>)}
  </section>
}
