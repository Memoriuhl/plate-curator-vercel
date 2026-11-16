'use client'

import { Button } from '@/components/ui/button'

export default function DashboardError({ reset }: { reset: () => void }) {
  return (
    <main className="app-main">
      <h1 className="page-title">Dashboard unavailable</h1>
      <p role="alert">Could not load this jurisdiction. Please try again.</p>
      <Button onClick={reset}>Try again</Button>
    </main>
  )
}
