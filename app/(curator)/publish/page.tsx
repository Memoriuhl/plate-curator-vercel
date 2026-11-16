import { Suspense } from 'react'
import { PublishWorkspace } from '@/components/publish/workspace'

export default function PublishPage() {
  return (
    <main className="p-4 md:p-6">
      <Suspense fallback={<p>Loading Publish…</p>}>
        <PublishWorkspace />
      </Suspense>
    </main>
  )
}
