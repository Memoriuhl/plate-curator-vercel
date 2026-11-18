import { loadEnvConfig } from '@next/env'
import { parseArgs } from 'node:util'
import { assertStagingProject, seedDemo } from '../lib/review/demo-seed'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { orderedStatePlates } from '../lib/catalog/order'

/**
 * Validate the staging target and prepare the baseline readers used to seed the demo
 * batch.
 */
async function main() {
  loadEnvConfig(process.cwd())
  const { values } = parseArgs({
    options: {
      uid: { type: 'string' },
      name: { type: 'string' },
      env: { type: 'string' },
    },
  })
  const projectId = process.env.GCP_PROJECT_ID
  assertStagingProject(projectId)
  const uid = values.uid ?? process.env.DEMO_EDITOR_UID
  const name = values.name ?? process.env.DEMO_EDITOR_NAME
  const env = values.env ?? process.env.REVIEW_ENV
  if (!uid || !name || !env)
    throw new Error(
      'Provide --uid, --name and --env or DEMO_EDITOR_UID, DEMO_EDITOR_NAME and REVIEW_ENV'
    )
  if (!/^(development|production|preview:.+)$/.test(env))
    throw new Error('Invalid review environment')
  process.env.VERCEL_ENV = env.startsWith('preview:') ? 'preview' : env
  if (env.startsWith('preview:'))
    process.env.VERCEL_GIT_COMMIT_REF = env.slice(8)
  process.env.CATALOG_SOURCE = 'firestore'
  const { catalog } = await import('../lib/server/context')
  const { stagingFirestore } = await import('../lib/gcp/firestore')
  const source = catalog()
  const snapshot = await source.readSnapshot()
  const curator = await source.readCuratorState()
  const batch = await seedDemo(
    {
      store: firestoreReviewStore(stagingFirestore(), env),
      /** Read one plate only when the requested baseline matches the demo snapshot. */
      baselineAtVersion: async (version, id) => {
        if (version !== snapshot.version)
          throw new Error('Baseline catalog version unavailable')
        return snapshot.plates.find((plate) => plate.id === id) ?? null
      },
      /** Find the seed plate in the loaded snapshot for unversioned lookups. */
      baseline: async (id) =>
        snapshot.plates.find((plate) => plate.id === id) ?? null,
      /** Read ordered state plates for the demo snapshot and its curator override. */
      stateBaseline: async (version, state, order) => {
        if (version !== snapshot.version)
          throw new Error('Baseline catalog version unavailable')
        return orderedStatePlates(
          snapshot,
          state,
          order === 'snapshot' ? { stateOrder: {}, stateProgress: {} } : curator
        )
      },
      /** Supply an ISO timestamp for the demo batch writes. */
      now: () => new Date().toISOString(),
    },
    {
      projectId: projectId!,
      env,
      editor: { uid, name, role: 'editor' },
      version: snapshot.version,
    }
  )
  console.log(
    JSON.stringify({
      state: batch.state,
      edits: batch.plateIds.length,
      baselineVersion: batch.baselineVersion,
      env,
    })
  )
}

main().catch(() => {
  console.error(
    'Demo seed failed; verify staging configuration, inputs and batch state'
  )
  process.exitCode = 1
})
