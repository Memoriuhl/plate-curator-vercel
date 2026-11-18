'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { EnhancedImageResult } from '@/components/dashboard/enhanced-image-result'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useSession } from '@/lib/client/session'
import type { EnhancedImageSuggestion } from '@/lib/jobs/image-enhancement'

type PlateImagePreview = { plateId: string; plateName: string; before?: string | null }

export function useLatestEnhancement(plateId: string, enabled: boolean) {
  const session = useSession(false)
  return useSWR<{ result: { jobId: string; suggestion: EnhancedImageSuggestion } | null }>(
    enabled && session?.user && process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' ? `/api/local-pipeline/plates/${encodeURIComponent(plateId)}/enhancement` : null,
    session?.api?.get ?? null,
    { dedupingInterval: 1000, shouldRetryOnError: false, refreshInterval: 5000 },
  ).data?.result
}

export function PlateEnhancementPreview({ plateId, plateName, before, children }: PlateImagePreview & { children: ReactNode }) {
  const result = useLatestEnhancement(plateId, true)
  return result
    ? <EnhancedImageResult key={result.jobId} {...result} plateName={plateName} before={before ?? undefined} compact />
    : children
}

export function PlateImageHover({ plateId, plateName, before, enabled = true, children }: PlateImagePreview & { enabled?: boolean; children: ReactNode }) {
  const [active, setActive] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  const result = useLatestEnhancement(plateId, enabled && active)
  if (!enabled || process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1') return children

  function enter() {
    clearTimeout(closeTimer.current)
    setActive(true)
  }

  function leave() {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setActive(false), 230)
  }

  return <Popover open={active && !!result} onOpenChange={open => { if (!open) setActive(false) }}>
    <PopoverAnchor asChild>
      <span className="inline-flex max-w-full shrink-0" onPointerEnter={enter} onPointerLeave={leave} onFocus={enter}
        onKeyDown={event => { if (event.key === 'Escape') setActive(false) }}>{children}</span>
    </PopoverAnchor>
    {result && <PopoverContent className="w-[min(420px,calc(100vw-16px))]" collisionPadding={8} aria-label={`${plateName} image enhancement`}
      onPointerEnter={enter} onPointerLeave={leave} onClick={event => event.stopPropagation()}
      onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}>
      <EnhancedImageResult key={result.jobId} {...result} plateName={plateName} before={before ?? undefined} compact />
    </PopoverContent>}
  </Popover>
}
