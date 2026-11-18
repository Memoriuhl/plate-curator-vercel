'use client'

import { useBatches, useMe } from '@/lib/client/hooks'
import { Suspense } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { mostRecentBatch } from '@/lib/review/batch-selection'
import { batchHref } from '@/lib/review/href'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

/** Render workspace navigation with a fallback while route and membership data load. */
export function WorkspaceTabs() {
  return (
    <Suspense fallback={<TabsView active="" />}>
      <CurrentTabs />
    </Suspense>
  )
}

/** Resolve the active workspace and available tabs from the current path and role. */
function CurrentTabs() {
  const pathname = usePathname()
  const me = useMe()
  const batch = useSearchParams()?.get('batch') ?? null
  const owner = me.data?.role === 'owner'
  const active = pathname.startsWith('/publish')
    ? '/publish'
    : pathname.startsWith('/review')
      ? '/review'
      : '/'
  const personalDashboard =
    owner &&
    batch === null &&
    (pathname.startsWith('/states/') || pathname.startsWith('/plates/'))
  const personal = useBatches(['open'], {
    mine: true,
    enabled: personalDashboard,
  })
  const currentBatch =
    batch ??
    (personalDashboard ? (mostRecentBatch(personal.data)?.id ?? null) : null)
  return (
    <TabsView
      batch={currentBatch}
      owner={owner && !(personalDashboard && personal.isLoading)}
      active={active}
    />
  )
}

/** Render the navigation links and selected state for the available workspace tabs. */
function TabsView({
  active,
  owner = false,
  batch = null,
}: {
  active: '' | '/' | '/review' | '/publish'
  owner?: boolean
  batch?: string | null
}) {
  return (
    <nav className="workspace-tabs" aria-label="Workspace">
      <Tabs value={active} activationMode="manual">
        <TabsList aria-label="Workspace">
          <TabsTrigger value="/" asChild>
            <Link
              href={batchHref('/', batch)}
              aria-current={active === '/' ? 'page' : undefined}
            >
              Dashboard
            </Link>
          </TabsTrigger>
          <TabsTrigger value="/review" asChild>
            <Link
              href="/review"
              aria-current={active === '/review' ? 'page' : undefined}
            >
              Review
            </Link>
          </TabsTrigger>
          {owner && (
            <TabsTrigger value="/publish" asChild>
              <Link
                href={batchHref('/publish', batch)}
                aria-current={active === '/publish' ? 'page' : undefined}
              >
                Publish
              </Link>
            </TabsTrigger>
          )}
        </TabsList>
      </Tabs>
    </nav>
  )
}
