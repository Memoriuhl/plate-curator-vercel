export function DashboardSkeleton({
  kind,
}: {
  kind: 'jurisdictions' | 'state' | 'families'
}) {
  return (
    <div
      className={`dashboard-skeleton skeleton-${kind}`}
      role="status"
      aria-label={`Loading ${kind}`}
    >
      <span className="sr-only">Loading {kind}…</span>
    </div>
  )
}
