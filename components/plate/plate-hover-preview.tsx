'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Plate } from '@/lib/catalog/types'
import {
  PLATE_IMAGE_SIZE,
  type PlateCardData,
} from '@/lib/catalog/dashboard-types'
import { familyRole } from '@/lib/catalog/families'
import { isComplete, plateChecks } from '@/lib/catalog/plate-checks'
import { PlateHoverContent } from './plate-hover-card'

/** Build the Dashboard card data for a plate in the browser, for the hover preview. */
export function previewCard(
  plate: Plate,
  imageUrl: string | null
): PlateCardData {
  const checks = plateChecks(plate, imageUrl)
  return {
    id: plate.id,
    state: plate.state,
    slug: plate.slug,
    displayName: plate.displayName,
    imageUrl,
    imageSize: PLATE_IMAGE_SIZE,
    tags: plate.tags ?? [],
    templateFamily: plate.templateFamily || null,
    templateRole: familyRole(plate),
    variantOfPlateId: plate.variantOfPlateId ?? null,
    isStandard: plate.isStandard ?? false,
    sortOrder: plate.sortOrder ?? 0,
    // The preview never saves, so it needs no revision fingerprint.
    revision: '',
    checks,
    funFacts: plate.funFacts ?? [],
    readMore: plate.readMore ?? [],
    wikiUrl: plate.wikiUrl ?? null,
    firstIssuedYear: plate.firstIssuedYear ?? null,
    complete: isComplete(checks),
  }
}

/**
 * Show the Dashboard's plate preview card when the pointer rests on a plate image, with
 * the same timing: it opens after a short pause, stays open while the pointer is on the
 * card, and closes shortly after the pointer leaves both.
 */
export function PlateHoverPreview({
  plate,
  imageUrl,
  children,
}: {
  plate: Plate
  imageUrl: string | null
  children: ReactNode
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  const card = useMemo(() => previewCard(plate, imageUrl), [plate, imageUrl])
  useEffect(
    () => () => {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
    },
    []
  )
  /** Close now, as a click or a press on the image does. */
  function close() {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    setAnchor(null)
  }
  /** Open after the Dashboard's short hover pause, unless the pointer moves away. */
  function enter(element: HTMLElement) {
    clearTimeout(closeTimer.current)
    clearTimeout(openTimer.current)
    openTimer.current = setTimeout(() => setAnchor(element), 150)
  }
  /** Close after a grace period that lets the pointer reach the card. */
  function leave() {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setAnchor(null), 230)
  }
  return (
    <>
      <span
        data-plate-hover-preview
        className="inline-flex max-w-full shrink-0"
        onPointerEnter={(event) => {
          if (event.buttons === 0) enter(event.currentTarget)
        }}
        onPointerLeave={leave}
        onPointerDown={close}
      >
        {children}
      </span>
      {anchor?.isConnected ? (
        <PlateHoverContent
          plate={card}
          anchor={anchor}
          onMouseEnter={() => clearTimeout(closeTimer.current)}
          onMouseLeave={leave}
        />
      ) : null}
    </>
  )
}
