import { afterEach, expect, test, vi } from 'vitest'
import { imageGroupCapabilities } from '../../lib/jobs/image-options'
import { detectGroupRuntime } from '../../worker/group-capabilities'
import { createImageGroupRunner } from '../../worker/image-group'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

test('missing runtime config disables actual unsupported options with reasons', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
  const runtime = await detectGroupRuntime({})
  const capabilities = imageGroupCapabilities(runtime)
  expect(capabilities.group).toMatchObject({ available: false, reason: expect.stringContaining('LOCAL_GROUP_PYTHON') })
  expect(capabilities.backgroundMask.available).toBe(false)
  expect(capabilities.visionTiebreak).toMatchObject({ available: false, reason: 'Needs a reachable local vision service' })
  expect(capabilities.previewOnly.available).toBe(false)
})

test('worker reports unavailable without invoking an unconfigured runtime', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const handler = createImageGroupRunner({})
  expect(await handler({ stage: 'group', plate: { state: 'AK', displayName: 'A', image: '', tags: [] } })).toMatchObject({ stageError: 'unavailable' })
})
