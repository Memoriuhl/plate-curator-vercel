'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useWorkspaceBatch } from '@/lib/client/hooks'
import { useBatchRevisionSignal } from '@/lib/client/live-signal'
import { useSWRConfig } from 'swr'
import { Button } from '@/components/ui/button'

export function SelectedBatchBar() {
  const workspace = useWorkspaceBatch()
  const pathname = usePathname()
  const params = useSearchParams()
  const { mutate } = useSWRConfig()
  const selected = workspace.mode === 'selected'
  const batch = selected ? workspace.detail?.batch : undefined
  const live = useBatchRevisionSignal(selected ? workspace.id : null, batch?.revision ?? -1)
  if (!selected) return null
  const back = new URLSearchParams(params.toString())
  back.delete('batch')
  return <div className="batch-actions" aria-label="Selected Batch" data-batch-id={workspace.id}>
    <strong>{batch?.name ?? (workspace.status === 'unavailable' ? "This Batch isn't available" : 'Loading Batch?')}</strong>
    <span>{workspace.id}</span>
    {batch ? <><span>{batch.createdByName ?? batch.createdBy}</span><span>rev {batch.revision}</span><span>{batch.state}</span></> : null}
    {workspace.status === 'unavailable' && batch ? <span>{"This Batch isn't available"}</span> : null}
    {workspace.status === 'read-only' ? <span>Read-only</span> : null}
    <span role="status">{live}</span>
    {live === 'Live updates unavailable' ? <Button variant="outline" onClick={() => void mutate('/api/batches/' + workspace.id)}>Refresh</Button> : null}
    <Button variant="outline" onClick={() => void navigator.clipboard.writeText(location.origin + pathname + '?batch=' + encodeURIComponent(workspace.id))}>Copy link</Button>
    <Link href={pathname + (back.size ? '?' + back.toString() : '')}>Back to your batch</Link>
  </div>
}
