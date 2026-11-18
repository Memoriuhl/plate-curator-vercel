'use client'

import { useState } from 'react'
import Image from 'next/image'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { useSession } from '@/lib/client/session'
import { enhancementOperations, enhancementStepLabels, type EnhancedImageSuggestion, type EnhancementFrame, type EnhancementStep } from '@/lib/jobs/image-enhancement'

function useEnhancedFrame(jobId: string | null, step?: EnhancementStep) {
  const { api } = useSession()
  return useSWR<{ image: string }>(jobId ? `/api/local-pipeline/jobs/${encodeURIComponent(jobId)}/enhanced-image${step ? `?step=${step}` : ''}` : null, api.get)
}

export function EnhancementComparison({ jobId, suggestion, plateName }: {
  jobId: string
  suggestion: EnhancedImageSuggestion
  plateName: string
}) {
  const frames = suggestion.frames
  if (!frames?.length) return <p className="caption">This run has no saved comparison frames.</p>
  const final = frames.at(-1)?.step
  return <div aria-label={`Image comparison for ${plateName}`} role="group" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
    {(['original', ...enhancementOperations] as const).map(step => {
      const frame = frames.find(item => item.step === step)
      return <figure key={step} className="grid min-w-0 gap-1.5">
        <figcaption className="caption font-medium">{enhancementStepLabels[step]}</figcaption>
        <div className="grid aspect-[2/1] place-items-center rounded-md bg-[var(--fill)]">
          {frame
            ? <ComparisonFrame jobId={jobId} frame={frame} final={step === final} plateName={plateName} />
            : <span className="caption">Skipped</span>}
        </div>
      </figure>
    })}
  </div>
}

function ComparisonFrame({ jobId, frame, final, plateName }: { jobId: string; frame: EnhancementFrame; final: boolean; plateName: string }) {
  const { data, error, mutate } = useEnhancedFrame(jobId, final ? undefined : frame.step)
  if (data?.image) return <Image src={`data:image/webp;base64,${data.image}`} alt={`${enhancementStepLabels[frame.step]} of ${plateName}`}
    width={frame.width} height={frame.height} unoptimized className="aspect-[2/1] w-full object-contain" />
  if (error) return <button type="button" className="caption underline" onClick={() => void mutate()}>Retry frame</button>
  return <span className="caption" role="status">Loading…</span>
}

export function EnhancedImageResult({ jobId, suggestion, plateName, before, compact = false }: {
  jobId: string
  suggestion: EnhancedImageSuggestion
  plateName: string
  before?: string
  compact?: boolean
}) {
  const [opened, setOpened] = useState(compact)
  const [selected, setSelected] = useState<EnhancementStep | 'enhanced'>()
  const [hovered, setHovered] = useState<EnhancementStep | 'enhanced'>()
  const last = suggestion.frames?.at(-1)?.step ?? 'enhanced'
  const step = hovered ?? selected ?? last
  const frame = suggestion.frames?.find(item => item.step === step)
  const originalFallback = step === 'original' && !frame && !!before
  const final = step === last
  const { data, error, mutate } = useEnhancedFrame(opened && !originalFallback ? jobId : null, final || step === 'enhanced' ? undefined : step)
  const src = originalFallback ? before : data?.image ? 'data:image/webp;base64,' + data.image : null
  const dimensions = frame ?? (originalFallback ? { width: suggestion.originalWidth, height: suggestion.originalHeight } : suggestion)
  const label = step === 'enhanced' ? 'Enhanced' : enhancementStepLabels[step]
  const choices = suggestion.frames?.map(item => item.step) ?? (before ? ['original', 'enhanced'] as const : [])

  return <section className="grid gap-2 rounded-[var(--radius-md)] bg-[var(--fill)] p-3" aria-label={`Enhanced image for ${plateName}`}>
    {!compact ? <h4 className="label">{plateName} · Enhanced image</h4> : null}
    {opened ? <>
      {choices.length ? <div className="flex flex-wrap gap-1" role="group" aria-label="Image preview steps" onPointerLeave={() => setHovered(undefined)}>
        {choices.map(item => <Button key={item} size="sm" variant={item === step ? 'primary' : 'outline'}
          aria-pressed={item === step} onPointerEnter={() => setHovered(item)} onFocus={() => setHovered(item)}
          onBlur={() => setHovered(undefined)} onClick={() => setSelected(item)}>
          {item === 'enhanced' ? 'Enhanced' : enhancementStepLabels[item]}
        </Button>)}
      </div> : null}
      <div className={before && !compact && final && !suggestion.frames ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-3'}>
        {before && !compact && final && !suggestion.frames ? <figure><figcaption className="caption">Original</figcaption><Image src={before} width={suggestion.originalWidth} height={suggestion.originalHeight} alt={`Original ${plateName}`} unoptimized className="h-auto max-h-48 w-auto max-w-full object-contain" /></figure> : null}
        {src ? <figure><figcaption className="caption">{label} · {dimensions.width} × {dimensions.height}</figcaption><Image src={src} width={dimensions.width} height={dimensions.height} alt={`${label} preview of ${plateName}`} unoptimized className="h-auto max-h-48 w-auto max-w-full object-contain" /></figure>
          : error ? <p className="caption" role="alert">Could not load the image preview. <button className="underline" onClick={() => void mutate()}>Retry</button></p>
          : <p className="caption" role="status">Loading image preview…</p>}
      </div>
      {src && final && !compact ? <Button asChild size="sm" variant="outline" className="justify-self-start"><a href={src} download={`${plateName}-enhanced.webp`}>Download WebP</a></Button> : null}
    </> : <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setOpened(true)}>Preview enhanced image</Button>}
  </section>
}
