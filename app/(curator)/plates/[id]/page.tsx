import { Suspense } from 'react'
import { connection } from 'next/server'
import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { loadJurisdiction, loadPlate } from '@/lib/catalog/dashboard'
import { PlatePage } from './_components/plate-page'
import { PlatePageSkeleton } from './_components/skeleton'
import { slimPlate } from './_lib/types'

/**
 * Load the plate and its jurisdiction and preserve the referring workspace in
 * navigation.
 */
async function PlateContent({ params }: { params: Promise<{ id: string }> }) {
  await connection()
  const { id } = await params
  let decoded: string
  try {
    decoded = decodeURIComponent(id)
  } catch {
    notFound()
  }
  const detail = await loadPlate(decoded)
  if (!detail) notFound()
  const jurisdiction = await loadJurisdiction(detail.plate.state)
  if (!jurisdiction) notFound()
  const { plate } = detail
  const requestHeaders = await headers()
  const returnQuery = new URLSearchParams()
  let fromState = false
  try {
    const referrer = new URL(requestHeaders.get('referer') ?? '')
    fromState = referrer.pathname === `/states/${plate.state}`
    if (fromState)
      for (const key of ['show', 'q', 'batch']) {
        if (referrer.searchParams.has(key))
          returnQuery.set(key, referrer.searchParams.get(key)!)
      }
  } catch {}
  return (
    <PlatePage
      plate={{
        ...slimPlate(plate),
        imageSize: plate.imageSize,
        description: plate.description,
        sourceUrl: plate.sourceUrl,
        wikiUrl: plate.wikiUrl,
        ...(process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
          ? {
              funFacts: plate.funFacts,
              readMore: plate.readMore,
              firstIssuedYear: plate.firstIssuedYear,
            }
          : {}),
      }}
      plates={jurisdiction.plates.map(slimPlate)}
      stateName={jurisdiction.name}
      prevId={detail.prevId}
      nextId={detail.nextId}
      returnQuery={returnQuery.toString()}
      fromState={fromState}
    />
  )
}

/** Render the plate page with a loading boundary around its catalog data. */
export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="app-main">
      <Suspense fallback={<PlatePageSkeleton />}>
        <PlateContent params={params} />
      </Suspense>
    </main>
  )
}
