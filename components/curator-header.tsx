import { Brand } from './app/brand'
import { RegionPill } from './app/region-pill'
import { WorkspaceTabs } from './app/workspace-tabs'
import { HeaderActions } from './app/header-actions'

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
