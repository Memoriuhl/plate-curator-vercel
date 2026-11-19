'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { EnhancedImageResult } from '@/components/dashboard/pipeline-runs/enhanced-image-result'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useSession } from '@/lib/client/session'
import { useLiveRefresh } from '@/lib/client/live-signal'
import type { EnhancedImageSuggestion } from '@/lib/jobs/image-enhancement'

type PlateImagePreview = {
  plateId: string
  plateName: string
  before?: string | null
}

export function useLatestEnhancement(plateId: string, enabled: boolean) {
  const session = useSession(false)
  const key =
    enabled && session?.user && process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
      ? `/api/local-pipeline/plates/${encodeURIComponent(plateId)}/enhancement`
      : null
  const enhancement = useSWR<{
    result: { jobId: string; suggestion: EnhancedImageSuggestion } | null
  }>(key, session?.api?.get ?? null, {
    dedupingInterval: 1000,
    shouldRetryOnError: false,
  })
  // A finished enhancement job is a pipeline write, so its signal brings the new image.
  // While the preview is open, a slow safety refresh covers a signal that never arrived.
  useLiveRefresh(['pipeline'], () => enhancement.mutate(), {
    enabled: key !== null,
    key: key ?? undefined,
    safetyMs: 60_000,
  })
  return enhancement.data?.result
}

export function PlateEnhancementPreview({
  plateId,
  plateName,
  before,
  children,
}: PlateImagePreview & { children: ReactNode }) {
  const result = useLatestEnhancement(plateId, true)
  return result ? (
    <EnhancedImageResult
      key={result.jobId}
      {...result}
      plateName={plateName}
      before={before ?? undefined}
      compact
    />
  ) : (
    children
  )
}

export function PlateImageHover({
  plateId,
  plateName,
  before,
  enabled = true,
  children,
}: PlateImagePreview & { enabled?: boolean; children: ReactNode }) {
  const [active, setActive] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  const result = useLatestEnhancement(plateId, enabled && active)
  if (!enabled || process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1')
    return children

  function enter() {
    clearTimeout(closeTimer.current)
    setActive(true)
  }

  function leave() {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setActive(false), 230)
  }

  return (
    <Popover
      open={active && !!result}
      onOpenChange={(open) => {
        if (!open) setActive(false)
      }}
    >
      <PopoverAnchor asChild>
        <span
          className="inline-flex max-w-full shrink-0"
          onPointerEnter={enter}
          onPointerLeave={leave}
          onFocus={enter}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setActive(false)
          }}
        >
          {children}
        </span>
      </PopoverAnchor>
      {result && (
        <PopoverContent
          className="w-[min(420px,calc(100vw-16px))]"
          collisionPadding={8}
          aria-label={`${plateName} image enhancement`}
          onPointerEnter={enter}
          onPointerLeave={leave}
          onClick={(event) => event.stopPropagation()}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <EnhancedImageResult
            key={result.jobId}
            {...result}
            plateName={plateName}
            before={before ?? undefined}
            compact
          />
        </PopoverContent>
      )}
    </Popover>
  )
}
