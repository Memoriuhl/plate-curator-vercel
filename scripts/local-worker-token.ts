import { appendFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { jobsDeps } from '../lib/server/context'
import { localJobsEnvironment, localPipelineScope } from '../lib/jobs/local-scope'

async function main() {
  if (process.env.GCP_PROJECT_ID !== 'license-plate-game-staging' || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== 'license-plate-game-staging') {
    throw new Error('Local worker setup requires staging')
  }
  const scope = localPipelineScope()
  if (!scope) throw new Error('Local pipeline must be enabled')
  const jobs = jobsDeps()
  if (jobs.store.env !== localJobsEnvironment(scope)) throw new Error('Local job environment mismatch')
  const token = process.env.LOCAL_PIPELINE_WORKER_TOKEN || randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  const existing = await jobs.store.getToken(hash)
  if (existing?.revokedAt != null) throw new Error('The configured local token is revoked')
  if (!existing) await jobs.store.createToken({ hash, env: jobs.store.env, workerId: `local-pipeline-${scope}`, createdAt: jobs.now(), revokedAt: null })
  if (!process.env.LOCAL_PIPELINE_WORKER_TOKEN) appendFileSync('.env.local', `\nLOCAL_PIPELINE_WORKER_TOKEN=${token}\n`)
  console.log('Local worker token configured in the isolated staging job environment; value withheld')
}

main().catch(() => { console.error('Local worker setup failed; configuration values withheld'); process.exitCode = 1 })
