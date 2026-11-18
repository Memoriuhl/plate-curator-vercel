export type ReadCatalogVersion = () => Promise<number>

const headers = { 'Cache-Control': 'private, no-store' }

/**
 * Probe the Firestore catalog pointer and return a private health response for service
 * monitoring.
 */
export async function firebaseHealth(readCatalogVersion: ReadCatalogVersion): Promise<Response> {
  try {
    const catalogVersion = await readCatalogVersion()
    return Response.json({ catalogVersion }, { headers })
  } catch (error) {
    console.error('Firebase health check failed', error)
    return Response.json({ error: 'firebase_unavailable' }, { status: 503, headers })
  }
}