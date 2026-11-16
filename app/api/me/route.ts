import { connection } from 'next/server'
import { currentActor } from '../../../lib/server/context'
import { json } from '../../../lib/server/respond'

export async function GET(request: Request) {
  await connection()
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  return json(auth.actor)
}
