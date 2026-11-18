'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Image from 'next/image'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent, PopoverTitle } from '@/components/ui/popover'
import { PlateImageHover } from '@/components/plate/plate-image-preview'
import { CheckStrip } from '@/components/plate/check-strip'
import { useSession } from '@/lib/client/session'
import type { QueueRunView } from '@/lib/jobs/queue-types'
import type { RunPlateDetail } from '@/lib/jobs/run-plates'
import { plateOutcomes, type StepProgress } from '@/lib/jobs/run-progress'
import { pipelineStepReason, pipelineStages } from './pipeline-stages'
import { pipelineQueueKey } from './use-pipeline-queue'
import styles from './pipeline-runs.module.css'

type Plates = { plateIds: string[]; steps: StepProgress[]; plates?: RunPlateDetail[] }

export function PipelinePlateList({ plateIds, steps, plates }: Plates) {
  const records = new Map(plates?.map(plate => [plate.id, plate]))
  const names = new Map(steps.map(step => [step.plateId, step.plateName]))
  const outcomes = plateOutcomes(steps)
  const groups = Map.groupBy(plateIds, id => records.get(id)?.state ?? 'Other plates')
  return <div className={styles.plateGroups}>{[...groups].map(([state, ids]) => <div key={state}>
    <h4 className="label">{state}</h4>
    <ul>{ids.map(id => {
      const plate = records.get(id)
      const outcome = outcomes.get(id)
      const step = outcome?.step
      const stage = step && (pipelineStages.find(item => item.id === step.stage)?.label ?? step.stage)
      return <li key={id} className={styles.plateRow}>
        {plate?.imageUrl ? <PlateImageHover plateId={id} plateName={plate.displayName} before={plate.imageUrl}>
          <Image src={plate.imageUrl} width={72} height={36} unoptimized alt="" />
        </PlateImageHover> : null}
        <div>
          <strong>{plate?.displayName ?? names.get(id) ?? id}</strong>
          {outcome && <p className="caption">{outcome.label}{step?.reason && ` · ${stage}: ${pipelineStepReason(step.reason)}`}</p>}
          {plate ? <CheckStrip checks={plate.checks} /> : null}
        </div>
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

export function PipelinePlateStack({ runId, local, resultsHref, watchUrl, ...props }: Plates & {
  runId: string; local?: boolean; resultsHref?: string; watchUrl?: string | null
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
  if (resultsHref) watch = <Button asChild size="sm" variant="outline"><Link href={resultsHref} prefetch={false} onClick={close}>Watch this workflow</Link></Button>
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
