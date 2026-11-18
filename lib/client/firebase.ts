import { getApps, initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'

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

/** Resolve the Firebase Auth instance tied to the curator's browser app. */
export function clientAuth() {
  return getAuth(clientApp())
}
