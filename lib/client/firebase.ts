import { getApps, initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'

/** Instances already pointed at a local emulator; connecting twice throws. */
export const emulatorConnected = new WeakSet<object>()

/**
 * Reuse the default Firebase app from the SDK's registry so Auth and live subscriptions
 * share one browser app.
 */
export function clientApp() {
  const existing = getApps().find((app) => app.name === '[DEFAULT]')
  if (existing) return existing

  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim(),
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim(),
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim(),
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID?.trim(),
  }
  if (Object.values(config).some((value) => !value)) {
    throw new Error(
      'Firebase sign-in is not configured. Check the NEXT_PUBLIC_FIREBASE_* variables for this environment and rebuild the app.'
    )
  }
  return initializeApp(config)
}

/**
 * Return a local emulator `host:port` only for a `demo-` project, which Firebase reserves
 * for emulator-only use, so a real project can never be pointed at an emulator.
 */
export function emulatorHost(value: string | undefined): string | null {
  const host = value?.trim()
  const project = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ?? ''
  return host && project.startsWith('demo-') ? host : null
}

/** Resolve the Firebase Auth instance tied to the curator's browser app. */
export function clientAuth() {
  const auth = getAuth(clientApp())
  const host = emulatorHost(process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST)
  if (host && !emulatorConnected.has(auth)) {
    connectAuthEmulator(auth, `http://${host}`, { disableWarnings: true })
    emulatorConnected.add(auth)
  }
  return auth
}
