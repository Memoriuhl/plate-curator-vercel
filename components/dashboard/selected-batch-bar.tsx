'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { batchApiPath } from '@/lib/client/api'
import { useWorkspaceBatch } from '@/lib/client/hooks'
import { useBatchRevisionSignal } from '@/lib/client/live-signal'
import { useSWRConfig } from 'swr'
import { Button } from '@/components/ui/button'
import { BatchLastChanged } from '@/components/review/batch-last-changed'
import { batchHref } from '@/lib/review/href'

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
  return <div className="batch-actions" aria-label="Selected Batch" data-batch-id={workspace.id} data-batch-revision={batch?.revision}>
    <strong>{batch?.name ?? (workspace.status === 'unavailable' ? "This Batch isn't available" : 'Loading Batch...')}</strong>
    {batch ? <><span>{batch.createdByName ?? batch.createdBy}</span><BatchLastChanged batch={batch} /><span>{batch.state}</span></> : null}
    {workspace.status === 'unavailable' && batch ? <span>{"This Batch isn't available"}</span> : null}
    {workspace.status === 'read-only' ? <span>Read-only</span> : null}
    <span role="status">{live}</span>
    {live === 'Live updates unavailable' ? <Button variant="outline" onClick={() => void mutate(batchApiPath(workspace.id))}>Refresh</Button> : null}
    <Button variant="outline" onClick={() => void navigator.clipboard.writeText(location.origin + batchHref(pathname, workspace.id))}>Copy link</Button>
    <Link href={pathname + (back.size ? '?' + back.toString() : '')}>Back to your batch</Link>
  </div>
}
