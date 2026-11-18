'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { IoChevronDown, IoDesktopOutline } from 'react-icons/io5'
import { SiVercel } from 'react-icons/si'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useSession } from '@/lib/client/session'
import { useMe } from '@/lib/client/hooks'
import type { GatewayRun } from '@/lib/jobs/gateway-runs'
import { taggingModel } from '@/lib/tagging/models'
import type { usePipelineQueue } from './use-pipeline-queue'
import { PipelineQueuePanel } from './pipeline-queue-panel'
import { PipelineRunCard } from './pipeline-run-card'
import { PipelineRunRail } from './pipeline-run-rail'
import { PipelinePlateList } from './pipeline-run-plates'
import styles from './pipeline-runs.module.css'

const devices = [
  { id: 'local', label: 'Local PC', Icon: IoDesktopOutline },
  { id: 'gateway', label: 'Vercel Gateway', Icon: SiVercel },
] as const

export function PipelineRuns({ queue }: { queue: ReturnType<typeof usePipelineQueue> }) {
  const local = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
  const [view, setView] = useState(local ? 'local' : 'gateway')
  const { user, api } = useSession()
  const me = useMe()
  const gateway = useSWR<{ runs: GatewayRun[]; observedAt: number }>(user && view === 'gateway' ? '/api/jobs/runs' : null, api.get, { refreshInterval: 3000 })
  const gatewayRuns = gateway.data?.runs ?? []
  const device = view === 'local' ? devices[0] : devices[1]
  const header = <header className={styles.header}>
    <h2 className="page-title">Plate Pipeline</h2>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={styles.device} aria-label={`View runs: ${device.label}`}>
          <device.Icon aria-hidden="true" /><span>{device.label}</span><IoChevronDown aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className={styles.deviceMenu} collisionPadding={12} aria-label="View runs">
        <DropdownMenuRadioGroup value={view} onValueChange={setView}>
          {devices.filter(option => local || option.id === 'gateway').map(({ id, label, Icon }) =>
            <DropdownMenuRadioItem key={id} value={id} className={styles.deviceOption}>
              <Icon aria-hidden="true" /><span>{label}</span>
            </DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  </header>
  const requester = (uid: string) => uid === me.data?.uid ? me.data.name ?? 'You' : undefined
  return <section className={styles.panel} aria-label="Plate Pipeline">{header}
    {view === 'local' ? <PipelineQueuePanel requester={requester} queue={queue} /> : <>
      {gateway.isLoading ? <p role="status" className="caption">Loading gateway runs…</p> : gateway.error ? <p role="alert">Could not load gateway runs. <Button size="sm" variant="ghost" onClick={() => void gateway.mutate()}>Refresh runs</Button></p> : !gatewayRuns.length ? <p className="caption">No gateway runs yet.</p> : null}
      <PipelineRunRail runs={gatewayRuns} observedAt={gateway.data?.observedAt} progress={run => run.progress}
        renderRun={run => <PipelineRunCard run={run} progress={run.progress} stages={['tag']} observedAt={gateway.data?.observedAt} requester={requester(run.requestedBy)} plates={run.plates} device="Vercel Gateway" />}
        renderHistory={run => <>
          <p className="caption">{taggingModel(run.modelId)?.label ?? run.modelId}</p>
          <PipelinePlateList plateIds={run.plateIds} steps={run.progress.steps} plates={run.plates} />
          {run.results.length ? <ul className={styles.stepList}>{run.results.map(result => <li key={result.jobId}><strong>{result.plateName}</strong><span>Suggested tags: {result.suggestions.join(', ') || 'None'}</span></li>)}</ul> : null}
        </>}
    />
    </>}
  </section>
}
