import { loadEnvConfig } from '@next/env'
import { assertStagingProject } from '../lib/review/demo-seed'

const usage =
  'Usage: npm run migrate:shared-draft -- --env <development|production|preview:branch> [--apply]'

/** Read the review environment and the apply flag; anything else is a usage error. */
function parseArgs(argv: string[]): { env: string; apply: boolean } {
  let env: string | undefined
  let apply = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--apply') apply = true
    else if (arg === '--env') env = argv[++index]
    else throw new Error(usage)
  }
  if (!env || !/^(development|production|preview:.+)$/.test(env))
    throw new Error(usage)
  return { env, apply }
}

/**
 * Fold the open, submitted and approved Batches of one review environment into its
 * shared draft. Without --apply it only prints what it would do. With
 * FIRESTORE_EMULATOR_HOST set it runs against the local emulator; otherwise it needs
 * the staging project configuration.
 */
async function main() {
  let args: { env: string; apply: boolean }
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
    return
  }
  loadEnvConfig(process.cwd())
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
  const { migrateToSharedDraft } = await import('../lib/review/migrate')
  const { snapshotReviewDeps } = await import('../lib/review/migration-deps')
  const { firestoreMigrationBlock } =
    await import('../lib/review/migration-gate')
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
      blocked: () => firestoreMigrationBlock(db, args.env),
    }
  )
  console.log(JSON.stringify(report, null, 2))
  if (report.refused) process.exitCode = 2
}

main().catch(() => {
  console.error('Shared draft migration failed; verify staging configuration')
  process.exitCode = 1
})
