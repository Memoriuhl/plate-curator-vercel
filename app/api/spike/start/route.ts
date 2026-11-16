import { start } from 'workflow/api'
import { rejectWithoutSpikeSecret } from '../../../../lib/spike/auth'
import { waitForSpikeNote } from '../../../../workflows/spike'

export async function POST(request: Request) {
const rejected = rejectWithoutSpikeSecret(request, process.env.SPIKE_SECRET)
if (rejected) return rejected

const minutes = Number(new URL(request.url).searchParams.get('minutes') ?? 1440)
const timeoutMinutes = Math.min(Math.max(minutes, 1), 1440)
const token = `spike-${crypto.randomUUID()}`
const run = await start(waitForSpikeNote, [token, timeoutMinutes])

return Response.json({ runId: run.runId, token, timeoutMinutes })
}