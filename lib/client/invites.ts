'use client'

import useSWR, { useSWRConfig } from 'swr'
import { useSession } from './session'

export type InviteLookup =
  { status: 'invalid' } | { status: 'valid' | 'expired'; email: string }

/**
 * Key lookup by token and bypass the browser cache so expiry and reissues are visible.
 */
export function useInvite(token: string) {
  return useSWR<InviteLookup>(
    `/api/invites/${encodeURIComponent(token)}`,
    async (path) => {
      const response = await fetch(path, { cache: 'no-store' })
      if (!response.ok) throw new Error('Invite lookup failed')
      return response.json()
    },
    { revalidateIfStale: true, dedupingInterval: 0 }
  )
}

/** Request a new invite link and refresh the membership data that displays it. */
export function useReissueInvite() {
  const { api } = useSession()
  const { mutate } = useSWRConfig()
  return async (email: string) => {
    const result = await api.send<{ inviteUrl: string }>(
      'POST',
      `/api/members/${encodeURIComponent(email)}/invite`,
      {}
    )
    await mutate('/api/members').catch(() => undefined)
    return result
  }
}
