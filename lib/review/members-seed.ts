import { normalizeEmail } from '../members/member'
import type { Member, MembersStore } from '../members/types'
import { assertStagingProject } from './demo-seed'

const required = ['SEED_DEMO_OWNER_EMAIL', 'SEED_DEMO_OWNER_UID', 'SEED_DEMO_EDITOR_EMAIL', 'SEED_DEMO_EDITOR_UID', 'SEED_OWNER_GOOGLE_EMAIL'] as const
export type MembersSeedInput = { projectId: string | undefined; env: Readonly<Record<string, string | undefined>>; now: () => string }

export function validateMembersSeed(input: MembersSeedInput): void {
  assertStagingProject(input.projectId)
  const missing = required.filter(key => !input.env[key]?.trim())
  if (missing.length) throw new Error(`Missing seed inputs: ${missing.join(', ')}`)
  const emails = [input.env.SEED_DEMO_OWNER_EMAIL!, input.env.SEED_DEMO_EDITOR_EMAIL!, input.env.SEED_OWNER_GOOGLE_EMAIL!].map(normalizeEmail)
  if (new Set(emails).size !== 3 || input.env.SEED_DEMO_OWNER_UID!.trim() === input.env.SEED_DEMO_EDITOR_UID!.trim()) throw new Error('Seed Members require distinct emails and account ids')
}

export async function seedMembers(store: MembersStore, input: MembersSeedInput): Promise<{ active: number; pending: number }> {
  validateMembersSeed(input)
  const env = input.env
  const starting: Pick<Member, 'email' | 'uid' | 'role' | 'signIn' | 'status'>[] = [
    { email: env.SEED_DEMO_OWNER_EMAIL!, uid: env.SEED_DEMO_OWNER_UID!.trim(), role: 'owner', signIn: 'password', status: 'active' },
    { email: env.SEED_DEMO_EDITOR_EMAIL!, uid: env.SEED_DEMO_EDITOR_UID!.trim(), role: 'editor', signIn: 'password', status: 'active' },
    { email: env.SEED_OWNER_GOOGLE_EMAIL!, uid: null, role: 'owner', signIn: 'google', status: 'pending' },
  ]
  const now = input.now()
  for (const member of starting) {
    const email = normalizeEmail(member.email)
    const existing = await store.getByEmail(email)
    await store.upsertSeed({ ...member, email, invite: null, invitedBy: null, createdAt: existing?.createdAt ?? now })
  }
  return { active: 2, pending: 1 }
}
