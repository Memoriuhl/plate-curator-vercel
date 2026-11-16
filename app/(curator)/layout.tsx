import { CuratorHeader } from '../../components/app/curator-header'
import { SessionGate } from '../../components/app/session-gate'

export default function CuratorLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <CuratorHeader />
      <SessionGate>{children}</SessionGate>
    </>
  )
}
