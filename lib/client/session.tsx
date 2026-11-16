'use client'

import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { SWRConfig } from 'swr'
import { createApiClient, type ApiClient } from './api'
import { clientAuth } from './firebase'

type Session = {
  user: User | null
  ready: boolean
  api: ApiClient
  signInWithGoogle(): Promise<void>
  signInWithEmail(email: string, password: string, create?: boolean): Promise<void>
  signOut(): Promise<void>
}

const SessionContext = createContext<Session | null>(null)

const api = createApiClient({ token: async () => (await clientAuth().currentUser?.getIdToken()) ?? null })

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => onIdTokenChanged(clientAuth(), (next) => {
    setUser(next)
    setReady(true)
  }), [])

  const session = useMemo<Session>(() => ({
    user,
    ready,
    api,
    async signInWithGoogle() {
      await signInWithPopup(clientAuth(), new GoogleAuthProvider())
    },
    async signInWithEmail(email, password, create = false) {
      const signIn = create ? createUserWithEmailAndPassword : signInWithEmailAndPassword
      await signIn(clientAuth(), email, password)
    },
    async signOut() {
      await signOut(clientAuth())
    },
  }), [user, ready])

  return (
    <SessionContext.Provider value={session}>
      <SWRConfig key={user?.uid ?? 'signed-out'} value={{ provider: () => new Map() }}>
        {children}
      </SWRConfig>
    </SessionContext.Provider>
  )
}

export function useSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession must be used inside SessionProvider')
  return session
}
