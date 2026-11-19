export const migrationUsage =
  'Usage: npm run migrate:shared-draft -- --env <development|production|preview:branch|name> [--apply]'

/**
 * Read the shared draft migration's review environment and apply flag.
 *
 * The environments are the ones `reviewEnv()` derives at runtime: development,
 * production, `preview:<branch>`, or any other `VERCEL_ENV` passed through as is, such
 * as an isolated `checkpoint` deployment. A name outside the first three must match
 * this checkout's `VERCEL_ENV`, so a mistyped name cannot fold a draft nobody reads.
 */
export function parseMigrationArgs(
  argv: string[],
  vercelEnv: string | undefined
): { env: string; apply: boolean } {
  let env: string | undefined
  let apply = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--apply') apply = true
    else if (arg === '--env') env = argv[++index]
    else throw new Error(migrationUsage)
  }
  if (!env) throw new Error(migrationUsage)
  if (/^(development|production|preview:.+)$/.test(env)) return { env, apply }
  // A preview deployment's environment always carries its branch.
  if (env === 'preview' || !/^[A-Za-z0-9_-]+$/.test(env))
    throw new Error(migrationUsage)
  if (env !== vercelEnv)
    throw new Error(
      `--env ${env} is not this checkout's environment; set VERCEL_ENV=${env} to migrate it`
    )
  return { env, apply }
}
