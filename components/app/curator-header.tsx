import { Brand } from './brand'
import { WorkspaceTabs } from './workspace-tabs'
import { HeaderActions } from './header-actions'

/**
 * Assemble the shared curator header with the brand, workspace tabs and account actions.
 */
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
