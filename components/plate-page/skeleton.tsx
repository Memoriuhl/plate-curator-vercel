/** Hold the plate detail layout and announce that its content is loading. */
export function PlatePageSkeleton() {
  return (
    <div role="status" aria-label="Loading plate" className="grid gap-4">
      <div className="h-12 animate-pulse rounded-xl bg-[var(--fill)]" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.48fr)_minmax(0,.9fr)]">
        {[680, 730, 980].map((height) => (
          <div
            key={height}
            style={{ minHeight: height }}
            className="animate-pulse rounded-[var(--radius-lg)] bg-[var(--card)]"
          />
        ))}
      </div>
    </div>
  )
}
