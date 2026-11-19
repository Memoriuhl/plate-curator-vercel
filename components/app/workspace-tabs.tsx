'use client'

import { useMe } from '@/lib/client/hooks'
import { Suspense } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { isSharedDraftId } from '@/lib/review/draft-id'
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
  // Without `?batch=` every tab shows the shared draft; Publish opens on it by default.
  return <TabsView batch={batch} owner={owner} active={active} />
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
              // The Dashboard shows only the shared draft; history opens in Review.
              href={batchHref(
                '/',
                batch && isSharedDraftId(batch) ? batch : null
              )}
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
