import { loadEnvConfig } from '@next/env'
import { assertStagingProject } from '../lib/review/demo-seed'
import { parseMigrationArgs } from '../lib/review/migration/migration-args'

/**
 * Fold the open, submitted and approved Batches of one review environment into its
 * shared draft. Without --apply it only prints what it would do. With
 * FIRESTORE_EMULATOR_HOST set it runs against the local emulator; otherwise it needs
 * the staging project configuration.
 */
async function main() {
  // Load the checkout's environment first: a named --env must match its VERCEL_ENV.
  loadEnvConfig(process.cwd())
  let args: { env: string; apply: boolean }
  try {
    args = parseMigrationArgs(process.argv.slice(2), process.env.VERCEL_ENV)
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
    return
  }
  const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)
  if (!emulator) assertStagingProject(process.env.GCP_PROJECT_ID)
  const { catalogSourceKind } = await import('../lib/catalog/source-kind')
  const kind = catalogSourceKind({
    CATALOG_SOURCE: process.env.CATALOG_SOURCE,
    VERCEL_ENV: process.env.VERCEL_ENV,
  })
  // A fixture catalog would fold staging Batches against the wrong baseline.
  if (kind === 'fixture' && !emulator)
    throw new Error('CATALOG_SOURCE=fixture only runs against the emulator')
  const { Firestore } = await import('@google-cloud/firestore')
  const { stagingFirestore } = await import('../lib/gcp/firestore')
  const { loadSnapshot } = await import('../lib/gcp/storage')
  const { fixtureSource } = await import('../lib/catalog/fixture-source')
  const { firestoreCatalogSource } =
    await import('../lib/catalog/firestore-source')
  const { firestoreReviewStore } = await import('../lib/review/firestore-store')
  const { migrateToSharedDraft } =
    await import('../lib/review/migration/migrate')
  const { snapshotReviewDeps } =
    await import('../lib/review/migration/migration-deps')
  const { firestoreMigrationFence } =
    await import('../lib/review/migration/migration-gate')
  const db = emulator
    ? new Firestore({ projectId: 'demo-plate-curator' })
    : stagingFirestore()
  const source =
    kind === 'fixture'
      ? fixtureSource()
      : firestoreCatalogSource(db, loadSnapshot)
  const report = await migrateToSharedDraft(
    snapshotReviewDeps(
      firestoreReviewStore(db, args.env),
      source,
      kind === 'fixture' ? () => source.readSnapshot() : loadSnapshot
    ),
    args.env,
    {
      apply: args.apply,
      actor: { uid: 'shared-draft-migration', name: 'Shared draft migration' },
      fence: firestoreMigrationFence(db, args.env),
    }
  )
  console.log(JSON.stringify(report, null, 2))
  if (report.refused) process.exitCode = 2
}

main().catch(() => {
  console.error('Shared draft migration failed; verify staging configuration')
  process.exitCode = 1
})
