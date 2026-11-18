'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Image from 'next/image'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent, PopoverTitle } from '@/components/ui/popover'
import { CheckStrip } from '@/components/plate/check-strip'
import { useSession } from '@/lib/client/session'
import type { QueueRunView } from '@/lib/jobs/queue-types'
import type { RunPlateDetail } from '@/lib/jobs/run-plates'
import type { StepProgress } from '@/lib/jobs/run-progress'
import { pipelineQueueKey } from './use-pipeline-queue'
import styles from './pipeline-runs.module.css'

type Plates = { plateIds: string[]; steps: StepProgress[]; plates?: RunPlateDetail[] }

export function PipelinePlateList({ plateIds, steps, plates }: Plates) {
  const records = new Map(plates?.map(plate => [plate.id, plate]))
  const names = new Map(steps.map(step => [step.plateId, step.plateName]))
  const groups = Map.groupBy(plateIds, id => records.get(id)?.state ?? 'Other plates')
  return <div className={styles.plateGroups}>{[...groups].map(([state, ids]) => <div key={state}>
    <h4 className="label">{state}</h4>
    <ul>{ids.map(id => {
      const plate = records.get(id)
      return <li key={id} className={styles.plateRow}>
        {plate?.imageUrl ? <Image src={plate.imageUrl} width={72} height={36} unoptimized alt="" /> : null}
        <div><strong>{plate?.displayName ?? names.get(id) ?? id}</strong>{plate ? <CheckStrip checks={plate.checks} /> : null}</div>
      </li>
    })}</ul>
  </div>)}</div>
}

function LocalPlates({ runId, enabled, ...props }: Plates & { runId: string; enabled: boolean }) {
  const { api, user } = useSession()
  const detail = useSWR<{ selected?: QueueRunView }>(user && enabled ? `${pipelineQueueKey}?detail=${encodeURIComponent(runId)}` : null, api.get)
  const plates = detail.data?.selected?.plates
  return <>
    {detail.isLoading ? <p role="status" className="caption">Loading plate details…</p> : null}
    {detail.error ? <p role="alert" className="caption">Could not load saved plate details.</p> : null}
    <PipelinePlateList {...props} plates={plates} />
  </>
}

export function PipelineRunPlates({ runId, local, ...props }: Plates & { runId: string; local?: boolean }) {
  const [enabled, setEnabled] = useState(false)
  if (!local) return <PipelinePlateList {...props} />
  return <details onToggle={event => setEnabled(event.currentTarget.open)}>
    <summary className="caption">View {props.plateIds.length} {props.plateIds.length === 1 ? 'plate' : 'plates'}</summary>
    {enabled ? <LocalPlates {...props} runId={runId} enabled /> : null}
  </details>
}

export function PipelinePlateStack({ runId, local, onWatch, watchUrl, ...props }: Plates & {
  runId: string; local?: boolean; onWatch?: () => void; watchUrl?: string | null
}) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clear = () => clearTimeout(timer.current)
  useEffect(() => () => clearTimeout(timer.current), [])

  function close() {
    clear()
    setOpen(false)
  }
  function leave() {
    clear()
    timer.current = setTimeout(close, 220)
  }
  const count = props.plateIds.length
  let watch: ReactNode
  if (onWatch) watch = <Button size="sm" variant="outline" onClick={() => { onWatch(); close() }}>Watch this workflow</Button>
  else if (watchUrl) watch = <Button asChild size="sm" variant="outline"><a href={watchUrl} target="_blank" rel="noopener noreferrer">Watch this workflow</a></Button>

  return <Popover open={open} onOpenChange={next => { if (!next) close() }}>
    <PopoverAnchor asChild>
      <button type="button" className={styles.plates} aria-label={`${count} ${count === 1 ? 'plate' : 'plates'} in run ${runId.slice(-8)}`} aria-expanded={open} aria-haspopup="dialog"
        onPointerEnter={event => {
          if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
          clear()
          if (!open) timer.current = setTimeout(() => setOpen(true), 1000)
        }} onPointerLeave={leave} onKeyDown={event => { if (event.key === 'Escape') close() }}>
        <strong>{count}</strong><span>{count === 1 ? 'plate' : 'plates'}</span>
      </button>
    </PopoverAnchor>
    <PopoverContent side="bottom" align="start" collisionPadding={12} className={styles.platePopover}
      aria-label="Plates in this run" onPointerEnter={clear} onPointerLeave={leave}
      onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}>
      <PopoverTitle>Plates in this run</PopoverTitle>
      {local ? <LocalPlates {...props} runId={runId} enabled={open} /> : <PipelinePlateList {...props} />}
      {watch}
    </PopoverContent>
  </Popover>
}
