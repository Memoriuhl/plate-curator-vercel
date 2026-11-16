import { Brand } from './brand'
import { RegionPill } from './region-pill'
import { WorkspaceTabs } from './workspace-tabs'
import { HeaderActions } from './header-actions'

export function CuratorHeader() {
  return (
    <header className="app-header">
      <div className="brand-region">
        <Brand />
        <RegionPill />
      </div>
      <WorkspaceTabs />
      <HeaderActions />
    </header>
  )
}
