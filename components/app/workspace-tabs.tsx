'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export function WorkspaceTabs() {
  const pathname = usePathname()
  const active = pathname.startsWith('/review') ? '/review' : '/'
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
              prefetch={false}
              aria-current={active === '/review' ? 'page' : undefined}
            >
              Review
            </Link>
          </TabsTrigger>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="link"
                tabIndex={0}
                aria-disabled="true"
                className="parked-tab"
              >
                Strip Art
              </span>
            </TooltipTrigger>
            <TooltipContent>Coming soon</TooltipContent>
          </Tooltip>
        </TabsList>
      </Tabs>
    </nav>
  )
}
