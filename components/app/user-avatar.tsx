'use client'

import type { ComponentProps } from 'react'
import type { User } from 'firebase/auth'
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar'

export type AvatarUser = Pick<User, 'displayName' | 'email' | 'photoURL'>

export function userAvatarName(user: AvatarUser | null) {
  return (user?.displayName || user?.email || 'Curator').trim() || 'Curator'
}

export function UserAvatar({ user, ...props }: Omit<ComponentProps<typeof Avatar>, 'children'> & { user: AvatarUser | null }) {
  const name = userAvatarName(user)
  return <Avatar data-user-avatar aria-label={name} {...props}>
    {user?.photoURL ? <AvatarImage src={user.photoURL} alt="" /> : null}
    <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
  </Avatar>
}
