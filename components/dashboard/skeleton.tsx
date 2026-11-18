/** Hold the dashboard layout while navigation or family grid data is loading. */
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
      {kind === 'jurisdictions' ? <span className="jurisdiction-region jurisdiction-region-skeleton" /> : null}
      {kind === 'jurisdictions' ? Array.from({ length: 8 }, (_, index) => (
        <span key={index} className="jurisdiction-skeleton-card" />
      )) : null}
    </div>
  )
}
