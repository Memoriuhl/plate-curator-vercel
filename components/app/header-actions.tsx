'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  IoChevronDownOutline,
  IoFileTrayOutline,
  IoLogOutOutline,
  IoPeopleOutline,
} from 'react-icons/io5'
import { useSession } from '../../lib/client/session'
import { useMe } from '../../lib/client/hooks'
import { UserAvatar } from './user-avatar'
import { ThemeToggle } from './theme-toggle'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { localPipelineReason } from '@/lib/local-pipeline'

export function HeaderActions() {
  const { user, ready, signOut } = useSession()
  const me = useMe()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  async function handleSignOut() {
    setPending(true)
    setError(false)
    try {
      await signOut()
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="header-actions">
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-label={`Inbox: ${localPipelineReason('No Inbox route or notification feed')}`}>
            <Button variant="ghost" size="icon" disabled aria-label="Inbox">
              <IoFileTrayOutline className="chrome-icon" aria-hidden="true" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{localPipelineReason('No Inbox route or notification feed')}</TooltipContent>
      </Tooltip>
      {!ready ? (
        <span role="status" className="caption">
          Loading session...
        </span>
      ) : user ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="gap-2 px-1"
              aria-label="Open profile menu"
              disabled={pending}
            >
              <UserAvatar user={user} />
              <IoChevronDownOutline
                className="chrome-icon"
                aria-hidden="true"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-64 max-w-[calc(100vw-32px)]"
          >
            <DropdownMenuLabel>{user.email || 'Signed in'}</DropdownMenuLabel>
            {me.data?.role === 'owner' ? (
              <DropdownMenuItem asChild>
                <Link href="/members"><IoPeopleOutline className="chrome-icon" aria-hidden="true" />Members</Link>
              </DropdownMenuItem>
            ) : null}
            <ThemeToggle />
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void handleSignOut()}>
              <IoLogOutOutline className="chrome-icon" aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button variant="ghost" asChild>
          <Link href="/sign-in">Sign in</Link>
        </Button>
      )}
      {error ? (
        <span role="alert" className="caption">
          Could not sign out. Try again.
        </span>
      ) : null}
    </div>
  )
}
