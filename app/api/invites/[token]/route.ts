import { connection } from 'next/server'
import { membersStore } from '@/lib/server/members'
import { json } from '@/lib/server/respond'
import { hashInviteToken } from '@/lib/members/invite'
import { memberStatus } from '@/lib/members/member'

/** Look up an invitation by token hash and expose whether it can still be accepted. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  await connection()
  const { token } = await context.params
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(token)) return json({ status: 'invalid' })
  const member = await membersStore().getByInviteHash(hashInviteToken(token))
  if (!member || member.status !== 'pending') return json({ status: 'invalid' })
  return json({
    email: member.email,
    status:
      memberStatus(member, new Date().toISOString()) === 'expired'
        ? 'expired'
        : 'valid',
  })
}
