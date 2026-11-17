'use client'

import { useMe } from '@/lib/client/hooks'
import { Suspense } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

export function WorkspaceTabs() {
  return (
    <Suspense fallback={<TabsView active="" />}>
      <CurrentTabs />
    </Suspense>
  )
}

function CurrentTabs() {
  const pathname = usePathname()
  const me = useMe()
  return <TabsView owner={me.data?.role === 'owner'} active={pathname.startsWith('/publish') ? '/publish' : pathname.startsWith('/review') ? '/review' : '/'} />
}

function TabsView({ active, owner = false }: { active: '' | '/' | '/review' | '/publish'; owner?: boolean }) {
  return (
    <nav className="workspace-tabs" aria-label="Workspace">
      <Tabs value={active} activationMode="manual">
        <TabsList aria-label="Workspace">
          <TabsTrigger value="/" asChild>
            <Link href="/" aria-current={active === '/' ? 'page' : undefined}>
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
          {owner && <TabsTrigger value="/publish" asChild><Link href="/publish" aria-current={active === '/publish' ? 'page' : undefined}>Publish</Link></TabsTrigger>}
        </TabsList>
      </Tabs>
    </nav>
  )
}
