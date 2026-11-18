import styles from './pipeline-results.module.css'

export function PipelineResultsSkeleton({
  stacked = false,
  header = false,
}: {
  stacked?: boolean
  header?: boolean
}) {
  return (
    <div role="status" aria-label="Loading run results">
      <div className={styles.skeleton} aria-hidden="true">
        {header && (
          <div className={styles.skeletonHeading}>
            <span />
            <span />
          </div>
        )}
        <div className={styles.skeletonSummary} />
        <ul
          className={
            stacked ? `${styles.grid} ${styles.stateCards}` : styles.grid
          }
        >
          {[0, 1, 2, 3].map((index) => (
            <li className={styles.skeletonCard} key={index}>
              <span className={styles.skeletonImage} />
              <div className={styles.skeletonText}>
                <span />
                <span />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
