import { Brand } from './brand'
import { WorkspaceTabs } from './workspace-tabs'
import { HeaderActions } from './header-actions'

export function CuratorHeader() {
  return (
    <header className="app-header">
      <div className="brand-region">
        <Brand />
      </div>
      <WorkspaceTabs />
      <HeaderActions />
    </header>
  )
}
