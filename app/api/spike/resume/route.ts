import { resumeHook } from 'workflow/api'
import { rejectWithoutSpikeSecret } from '../../../../lib/spike/auth'
import { currentActor } from '../../../../lib/server/context'

/** Authorize and resume the protected test workflow with a supplied note. */
export async function POST(request: Request) {
const rejected = rejectWithoutSpikeSecret(request, process.env.SPIKE_SECRET)
if (rejected) return rejected
const auth = await currentActor(request)
if (!auth.ok) return auth.response

const { token, note } = await request.json()
await resumeHook(token, { note })

return Response.json({ resumed: token })
}
