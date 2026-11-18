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
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { normalizeEmail } from '../members/member'
import { SWRConfig } from 'swr'
import { createApiClient, type ApiClient } from './api'
import { clientAuth } from './firebase'

type Session = {
  user: User | null
  ready: boolean
  api: ApiClient
  signInWithGoogle(loginHint?: string): Promise<void>
  signInWithEmail(email: string, password: string, create?: boolean): Promise<void>
  signOut(): Promise<void>
}

const SessionContext = createContext<Session | null>(null)

const api = createApiClient({ token: async () => (await clientAuth().currentUser?.getIdToken()) ?? null })

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [initializationFailed, setInitializationFailed] = useState(false)
  const checkingGoogle = useRef(false)

  useEffect(() => {
    function failInitialization() {
      setUser(null)
      setReady(false)
      setInitializationFailed(true)
    }
    try {
      return onIdTokenChanged(clientAuth(), (next) => {
        if (checkingGoogle.current) return
        setUser(next)
        setReady(true)
        setInitializationFailed(false)
      }, failInitialization)
    } catch {
      failInitialization()
    }
  }, [])

  const session = useMemo<Session>(() => ({
    user,
    ready,
    api,
    async signInWithGoogle(loginHint) {
      const provider = new GoogleAuthProvider()
      if (loginHint) provider.setCustomParameters({ login_hint: loginHint })
      checkingGoogle.current = true
      try {
        const { user: next } = await signInWithPopup(clientAuth(), provider)
        if (loginHint && normalizeEmail(next.email ?? '') !== normalizeEmail(loginHint)) {
          await signOut(clientAuth())
          throw new Error(`That Google account isn't the invited one. Choose ${loginHint} in Google's account picker.`)
        }
        setUser(next)
      } finally {
        checkingGoogle.current = false
      }
    },
    async signInWithEmail(email, password, create = false) {
      const signIn = create ? createUserWithEmailAndPassword : signInWithEmailAndPassword
      await signIn(clientAuth(), email, password)
    },
    async signOut() {
      await signOut(clientAuth())
    },
  }), [user, ready])

  if (initializationFailed) return (
    <main className="sign-in-main">
      <section className="sign-in-card" role="alert" aria-labelledby="auth-unavailable-title">
        <h1 id="auth-unavailable-title" className="dialog-title">Sign-in unavailable</h1>
        <p>Firebase authentication could not initialize. Check the NEXT_PUBLIC_FIREBASE_* configuration for this environment, then restart or redeploy the app.</p>
        <a href="">Reload page</a>
      </section>
    </main>
  )

  return (
    <SessionContext.Provider value={session}>
      <SWRConfig key={user?.uid ?? 'signed-out'} value={{ provider: () => new Map() }}>
        {children}
      </SWRConfig>
    </SessionContext.Provider>
  )
}

export function useSession(required: false): Session | null
export function useSession(): Session
export function useSession(required = true): Session | null {
  const session = useContext(SessionContext)
  if (!session && required) throw new Error('useSession must be used inside SessionProvider')
  return session
}
