import { loadEnvConfig } from '@next/env'
import { firestoreMembersStore } from '../lib/members/firestore-store'
import { seedMembers, validateMembersSeed } from '../lib/review/members-seed'

async function main() {
  loadEnvConfig(process.cwd())
  const input = { projectId: process.env.GCP_PROJECT_ID, env: process.env, now: () => new Date().toISOString() }
  validateMembersSeed(input)
  const { stagingFirestore } = await import('../lib/gcp/firestore')
  console.log(JSON.stringify(await seedMembers(firestoreMembersStore(stagingFirestore()), input)))
}

main().catch(error => {
  const message = error instanceof Error && error.message.startsWith('Missing seed inputs:') ? error.message : 'Members seed failed; verify staging configuration and inputs'
  console.error(message)
  process.exitCode = 1
})
