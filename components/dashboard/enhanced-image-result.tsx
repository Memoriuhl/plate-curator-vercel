'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { useSession } from '@/lib/client/session'
import type { EnhancedImageSuggestion } from '@/lib/jobs/image-enhancement'

export function EnhancedImageResult({ jobId, suggestion, plateName, before }: {
  jobId: string
  suggestion: EnhancedImageSuggestion
  plateName: string
  before?: string
}) {
  const { api } = useSession()
  const [src, setSrc] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  async function load() {
    setError(false)
    setLoading(true)
    try {
      const { image } = await api.get<{ image: string }>(`/api/local-pipeline/jobs/${encodeURIComponent(jobId)}/enhanced-image`)
      setSrc('data:image/webp;base64,' + image)
    } catch { setError(true) }
    finally { setLoading(false) }
  }
  return <section className="grid gap-2 rounded-[var(--radius-md)] bg-[var(--fill)] p-3" aria-label={`Enhanced image for ${plateName}`}>
    <h4 className="label">{plateName} · Enhanced image</h4>
    <p className="caption">{suggestion.originalWidth} × {suggestion.originalHeight} → {suggestion.width} × {suggestion.height}</p>
    {src ? <>
      <div className="grid gap-3 sm:grid-cols-2">
        {before ? <figure><figcaption className="caption">Original</figcaption><Image src={before} width={suggestion.originalWidth} height={suggestion.originalHeight} alt={`Original ${plateName}`} unoptimized className="h-auto max-h-48 w-auto object-contain" /></figure> : null}
        <figure><figcaption className="caption">Enhanced</figcaption><Image src={src} width={suggestion.width} height={suggestion.height} alt={`Enhanced ${plateName}`} unoptimized className="h-auto max-h-48 w-auto object-contain" /></figure>
      </div>
      <Button asChild size="sm" variant="outline" className="justify-self-start"><a href={src} download={`${plateName}-enhanced.webp`}>Download WebP</a></Button>
    </> : <Button size="sm" variant="outline" className="justify-self-start" disabled={loading} onClick={() => void load()}>{loading ? 'Loading image…' : 'Preview enhanced image'}</Button>}
    {error ? <p className="caption" role="alert">Could not load the enhanced image. Try again.</p> : null}
  </section>
}
